import { Client, Keypair, contract, rpc, scValToNative, type xdr } from "@zephyr-ramp/escrow-client";
import type { EscrowConfig, EscrowEvent, EscrowGateway } from "./types.js";

/** Error names from zephyr-contracts `Error`, by code. */
const ESCROW_ERRORS: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotInitialized",
  3: "InvalidAmount",
  4: "InvalidTimeout",
  5: "DuplicateTxId",
  6: "NotFound",
  7: "NotLocked",
  8: "Expired",
  9: "NotExpired",
  10: "Paused",
};

export interface SorobanEscrowOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  /** Secret of the escrow's `anchor` address; signs `claim` and `cancel`. */
  anchorSecret: string;
  /** Ledger to start reading events from when there is no saved cursor. */
  startLedger?: number | undefined;
  log?: { warn: (obj: object, msg?: string) => void };
}

/** Talks to the deployed escrow through Soroban RPC and the generated `@zephyr-ramp/escrow-client`. */
export class SorobanEscrowGateway implements EscrowGateway {
  readonly contractId: string;
  private readonly server: rpc.Server;
  private readonly client: Client;

  constructor(private readonly opts: SorobanEscrowOptions) {
    this.contractId = opts.contractId;
    this.server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith("http://") });
    const anchor = Keypair.fromSecret(opts.anchorSecret);
    this.client = new Client({
      contractId: opts.contractId,
      networkPassphrase: opts.networkPassphrase,
      rpcUrl: opts.rpcUrl,
      allowHttp: opts.rpcUrl.startsWith("http://"),
      publicKey: anchor.publicKey(),
      ...contract.basicNodeSigner(anchor, opts.networkPassphrase),
    });
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  async fetchEvents(cursor: string | undefined) {
    const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [this.contractId] }];
    const limit = 100;
    let request: rpc.Api.GetEventsRequest;
    if (cursor) {
      request = { filters, cursor, limit };
    } else {
      // No saved cursor: start from the configured ledger, or the oldest one RPC retains.
      const latest = await this.latestLedger();
      const startLedger = this.opts.startLedger ?? Math.max(latest - 17_280, 1);
      request = { filters, startLedger, limit };
    }

    let response: rpc.Api.GetEventsResponse;
    try {
      response = await this.server.getEvents(request);
    } catch (err) {
      // The start ledger fell outside RPC retention: begin from the oldest available.
      if (!cursor && err instanceof Error && /ledger range/i.test(err.message)) {
        const health = await this.server.getHealth();
        response = await this.server.getEvents({ filters, startLedger: health.oldestLedger, limit });
      } else {
        throw err;
      }
    }

    const events: EscrowEvent[] = [];
    for (const e of response.events) {
      const decoded = decodeEvent(e);
      if (decoded) events.push(decoded);
    }
    return { events, cursor: response.cursor || cursor };
  }

  async getConfig(): Promise<EscrowConfig> {
    const tx = await this.client.get_config();
    const c = unwrap(tx.result, "get_config");
    return {
      anchor: c.anchor,
      token: c.token,
      minTimeoutLedgers: c.min_timeout_ledgers,
      maxTimeoutLedgers: c.max_timeout_ledgers,
      paused: c.paused,
    };
  }

  async claim(txIdHex: string): Promise<string> {
    return this.invoke("claim", () => this.client.claim({ tx_id: Buffer.from(txIdHex, "hex") }));
  }

  async cancel(txIdHex: string): Promise<string> {
    return this.invoke("cancel", () => this.client.cancel({ tx_id: Buffer.from(txIdHex, "hex") }));
  }

  private async invoke(
    name: string,
    build: () => Promise<contract.AssembledTransaction<contract.Result<void>>>,
  ): Promise<string> {
    const tx = await build();
    // Simulation already ran: surface contract errors before paying fees.
    unwrap(tx.result, name);
    const sent = await tx.signAndSend();
    unwrap(sent.result, name);
    const hash = sent.getTransactionResponse?.txHash ?? sent.sendTransactionResponse?.hash;
    if (!hash) throw new Error(`escrow ${name}: no transaction hash returned`);
    return hash;
  }
}

function unwrap<T>(result: contract.Result<T>, fn: string): T {
  if (result.isErr()) {
    const err = result.unwrapErr() as { message?: string; code?: number } | undefined;
    const code = typeof err?.code === "number" ? err.code : undefined;
    const name = code !== undefined ? (ESCROW_ERRORS[code] ?? `code ${code}`) : (err?.message ?? "unknown");
    throw new Error(`escrow ${fn} failed: ${name}`);
  }
  return result.unwrap();
}

/** Decodes a `locked` / `claimed` / `refunded` event. Returns undefined for other events. */
export function decodeEvent(e: {
  id: string;
  ledger: number;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}): EscrowEvent | undefined {
  const [nameVal, txIdVal] = e.topic;
  if (!nameVal || !txIdVal) return undefined;
  const name = scValToNative(nameVal) as unknown;
  const txIdRaw = scValToNative(txIdVal) as unknown;
  if (typeof name !== "string" || !(txIdRaw instanceof Uint8Array)) return undefined;
  const txId = Buffer.from(txIdRaw).toString("hex");
  const data = scValToNative(e.value) as Record<string, unknown>;
  const base = { id: e.id, txId, ledger: e.ledger, txHash: e.txHash };

  switch (name) {
    case "locked":
      return {
        ...base,
        type: "locked",
        user: String(data.user),
        amount: BigInt(data.amount as bigint),
        expiresLedger: Number(data.expires_ledger),
      };
    case "claimed":
      return { ...base, type: "claimed", anchor: String(data.anchor), amount: BigInt(data.amount as bigint) };
    case "refunded":
      return {
        ...base,
        type: "refunded",
        user: String(data.user),
        amount: BigInt(data.amount as bigint),
        byAnchor: Boolean(data.by_anchor),
      };
    default:
      return undefined;
  }
}
