import { createHash } from "node:crypto";

/**
 * The escrow `tx_id` for a Zephyr transaction: sha256 of the transaction UUID's
 * UTF-8 bytes, as lowercase hex. The frontend computes the same value.
 */
export function escrowTxId(transactionId: string): string {
  return createHash("sha256").update(transactionId, "utf8").digest("hex");
}

/** A decoded event from the zephyr-contracts escrow. Amounts are stroops. */
export type EscrowEvent =
  | {
      type: "locked";
      id: string;
      txId: string;
      ledger: number;
      txHash: string;
      user: string;
      amount: bigint;
      expiresLedger: number;
    }
  | { type: "claimed"; id: string; txId: string; ledger: number; txHash: string; anchor: string; amount: bigint }
  | {
      type: "refunded";
      id: string;
      txId: string;
      ledger: number;
      txHash: string;
      user: string;
      amount: bigint;
      byAnchor: boolean;
    };

export interface EscrowConfig {
  anchor: string;
  token: string;
  minTimeoutLedgers: number;
  maxTimeoutLedgers: number;
  paused: boolean;
}

/**
 * Everything the backend needs from the escrow contract. `SorobanEscrowGateway`
 * talks to Soroban RPC; `SandboxEscrowGateway` simulates the chain in memory.
 */
export interface EscrowGateway {
  readonly contractId: string;
  /** Events after `cursor` (or from the configured start when undefined), oldest first. */
  fetchEvents(cursor: string | undefined): Promise<{ events: EscrowEvent[]; cursor: string | undefined }>;
  latestLedger(): Promise<number>;
  getConfig(): Promise<EscrowConfig>;
  /** Anchor takes the funds after the fiat payout. Returns the Stellar tx hash. */
  claim(txIdHex: string): Promise<string>;
  /** Anchor returns the funds to the user. Returns the Stellar tx hash. */
  cancel(txIdHex: string): Promise<string>;
}
