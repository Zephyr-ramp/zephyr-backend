import { randomBytes } from "node:crypto";
import { AnchorError } from "../lib/errors.js";
import type { EscrowConfig, EscrowEvent, EscrowGateway } from "./types.js";

interface SandboxEscrow {
  user: string;
  amount: bigint;
  expiresLedger: number;
  status: "Locked" | "Claimed" | "Refunded";
}

/**
 * An in-memory stand-in for the escrow contract, with the same rules. Used by
 * the tests and by the sandbox (`ENABLE_SANDBOX=true` without
 * `ESCROW_CONTRACT_ID`), so the whole escrow flow can run offline.
 */
export class SandboxEscrowGateway implements EscrowGateway {
  readonly contractId = "SANDBOX_ESCROW";
  readonly anchor = "GSANDBOXANCHOR";
  ledger = 1_000;
  failClaim = false;
  failCancel = false;
  private readonly escrows = new Map<string, SandboxEscrow>();
  private readonly events: EscrowEvent[] = [];

  constructor(
    private readonly config: Omit<EscrowConfig, "anchor" | "token"> = {
      minTimeoutLedgers: 720,
      maxTimeoutLedgers: 120_960,
      paused: false,
    },
  ) {}

  /** What the user's wallet does: lock funds for `txId`. */
  lock(input: { txId: string; user: string; amount: bigint; timeoutLedgers: number }): EscrowEvent {
    if (this.escrows.has(input.txId)) throw new AnchorError(409, "escrow DuplicateTxId");
    if (input.amount <= 0n) throw new AnchorError(400, "escrow InvalidAmount");
    if (input.timeoutLedgers < this.config.minTimeoutLedgers || input.timeoutLedgers > this.config.maxTimeoutLedgers) {
      throw new AnchorError(400, "escrow InvalidTimeout");
    }
    const expiresLedger = this.ledger + input.timeoutLedgers;
    this.escrows.set(input.txId, { user: input.user, amount: input.amount, expiresLedger, status: "Locked" });
    return this.emit({ type: "locked", txId: input.txId, user: input.user, amount: input.amount, expiresLedger });
  }

  /** What anyone can do after expiry: send the funds back to the user. */
  refund(txId: string): EscrowEvent {
    const e = this.locked(txId);
    if (this.ledger < e.expiresLedger) throw new AnchorError(409, "escrow NotExpired");
    e.status = "Refunded";
    return this.emit({ type: "refunded", txId, user: e.user, amount: e.amount, byAnchor: false });
  }

  advance(ledgers: number) {
    this.ledger += ledgers;
  }

  status(txId: string) {
    return this.escrows.get(txId)?.status;
  }

  async fetchEvents(cursor: string | undefined) {
    const from = cursor ? Number(cursor) : 0;
    return { events: this.events.slice(from), cursor: String(this.events.length) };
  }

  async latestLedger() {
    return this.ledger;
  }

  async getConfig(): Promise<EscrowConfig> {
    return { ...this.config, anchor: this.anchor, token: "SANDBOX_USDC" };
  }

  async claim(txId: string): Promise<string> {
    if (this.failClaim) throw new Error("sandbox: claim failed");
    const e = this.locked(txId);
    if (this.ledger >= e.expiresLedger) throw new Error("escrow claim failed: Expired");
    e.status = "Claimed";
    return this.emit({ type: "claimed", txId, anchor: this.anchor, amount: e.amount }).txHash;
  }

  async cancel(txId: string): Promise<string> {
    if (this.failCancel) throw new Error("sandbox: cancel failed");
    const e = this.locked(txId);
    e.status = "Refunded";
    return this.emit({ type: "refunded", txId, user: e.user, amount: e.amount, byAnchor: true }).txHash;
  }

  private locked(txId: string): SandboxEscrow {
    const e = this.escrows.get(txId);
    if (!e) throw new Error("escrow failed: NotFound");
    if (e.status !== "Locked") throw new Error("escrow failed: NotLocked");
    return e;
  }

  private emit(partial: DistributiveOmit<EscrowEvent, "id" | "ledger" | "txHash">): EscrowEvent {
    const event = {
      ...partial,
      id: String(this.events.length),
      ledger: this.ledger,
      txHash: `sandbox_${randomBytes(16).toString("hex")}`,
    } as EscrowEvent;
    this.events.push(event);
    return event;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
