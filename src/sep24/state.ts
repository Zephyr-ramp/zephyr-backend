import { AnchorError } from "../lib/errors.js";
import type { TransactionKind, TransactionStatus, WithdrawMode } from "../store/types.js";

/**
 * The on/off-ramp state machine. Every status change goes through
 * `assertTransition`, so an unexpected event can never move a transaction
 * somewhere it shouldn't be.
 *
 * Deposit (USD -> USDC):
 *   incomplete -> pending_user_transfer_start -> pending_anchor -> pending_stellar -> completed
 *
 * Standard withdrawal (USDC payment with memo -> USD):
 *   incomplete -> pending_user_transfer_start -> pending_anchor -> pending_external -> completed
 *
 * Escrow withdrawal (USDC locked in the escrow contract -> USD):
 *   incomplete -> pending_user_transfer_start -> pending_anchor -> pending_external
 *     -> pending_stellar (claiming) -> completed
 *     -> refunded (payout failed: anchor cancels, or the user refunds after expiry)
 *
 * Anything unexpected goes to `error` for manual review. `error` is terminal
 * for automation: only an operator may move it on.
 */
type Graph = Partial<Record<TransactionStatus, readonly TransactionStatus[]>>;

const DEPOSIT: Graph = {
  incomplete: ["pending_user_transfer_start", "expired", "error"],
  pending_user_transfer_start: ["pending_anchor", "expired", "error"],
  pending_anchor: ["pending_stellar", "error"],
  pending_stellar: ["completed", "error"],
};

const STANDARD_WITHDRAWAL: Graph = {
  incomplete: ["pending_user_transfer_start", "expired", "error"],
  pending_user_transfer_start: ["pending_anchor", "expired", "error"],
  pending_anchor: ["pending_external", "error"],
  pending_external: ["completed", "error"],
};

const ESCROW_WITHDRAWAL: Graph = {
  incomplete: ["pending_user_transfer_start", "expired", "error"],
  // `refunded` directly: the user refunded an escrow the anchor never saw.
  pending_user_transfer_start: ["pending_anchor", "refunded", "expired", "error"],
  pending_anchor: ["pending_external", "refunded", "error"],
  pending_external: ["pending_stellar", "refunded", "error"],
  pending_stellar: ["completed", "refunded", "error"],
};

export function transitionsFor(kind: TransactionKind, mode: WithdrawMode | undefined): Graph {
  if (kind === "deposit") return DEPOSIT;
  return mode === "escrow" ? ESCROW_WITHDRAWAL : STANDARD_WITHDRAWAL;
}

export function canTransition(
  kind: TransactionKind,
  mode: WithdrawMode | undefined,
  from: TransactionStatus,
  to: TransactionStatus,
): boolean {
  if (from === to) return true;
  return transitionsFor(kind, mode)[from]?.includes(to) ?? false;
}

export function assertTransition(
  tx: { id: string; kind: TransactionKind; withdrawMode?: WithdrawMode | undefined; status: TransactionStatus },
  to: TransactionStatus,
): void {
  if (!canTransition(tx.kind, tx.withdrawMode, tx.status, to)) {
    throw new AnchorError(409, `invalid transition ${tx.status} -> ${to} for ${tx.kind} ${tx.id}`);
  }
}

export const TERMINAL_STATUSES: readonly TransactionStatus[] = ["completed", "refunded", "expired", "error"];
