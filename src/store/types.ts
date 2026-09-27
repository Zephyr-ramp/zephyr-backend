/**
 * SEP-24 transaction statuses. These are exactly the names from the SEP-24
 * spec, used unchanged across the backend, the frontend and the API.
 */
export const TRANSACTION_STATUSES = [
  "incomplete",
  "pending_user_transfer_start",
  "pending_user_transfer_complete",
  "pending_external",
  "pending_anchor",
  "pending_stellar",
  "pending_trust",
  "pending_user",
  "completed",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export type TransactionKind = "deposit" | "withdrawal";

/**
 * How a withdrawal's USDC reaches the anchor.
 * - `standard`: a Stellar payment with a memo to the distribution account (any SEP-24 wallet).
 * - `escrow`: locked in the zephyr-contracts escrow; the anchor claims it after paying out.
 */
export type WithdrawMode = "standard" | "escrow";

/** SEP-24 `refunds` object. Amounts are decimal strings. */
export interface Refunds {
  amount_refunded: string;
  amount_fee: string;
  payments: { id: string; id_type: "stellar" | "external"; amount: string; fee: string }[];
}

export interface EscrowInfo {
  contractId: string;
  /** Hex sha256 of the transaction id: the escrow's `tx_id`. */
  txId: string;
  /** Set once the `locked` event is seen. */
  user?: string | undefined;
  expiresLedger?: number | undefined;
  lockTxHash?: string | undefined;
  claimTxHash?: string | undefined;
  refundTxHash?: string | undefined;
}

export interface Transaction {
  id: string;
  kind: TransactionKind;
  status: TransactionStatus;
  /** Authenticated Stellar account (SEP-10 `sub`) that owns this transaction. */
  account: string;
  /** Optional muxed/memo sub-account from SEP-10. */
  accountMemo?: string | undefined;
  /** SEP-10 `client_domain` of the wallet that started the transaction. */
  clientDomain?: string | undefined;
  assetCode: string;
  assetIssuer: string;

  amountIn?: string | undefined;
  amountOut?: string | undefined;
  amountFee?: string | undefined;

  /** Deposits: Stellar account that receives USDC. */
  to?: string | undefined;
  /** Withdrawals: Stellar account that sends USDC. */
  from?: string | undefined;

  /** Withdrawals: where the user sends USDC, and the memo that identifies this transaction. */
  withdrawAnchorAccount?: string | undefined;
  withdrawMemo?: string | undefined;
  withdrawMode?: WithdrawMode | undefined;
  escrow?: EscrowInfo | undefined;

  /** Deposits: instructions shown to the user for sending fiat. */
  depositInstructions?: Record<string, string> | undefined;

  stellarTransactionId?: string | undefined;
  externalTransactionId?: string | undefined;
  message?: string | undefined;

  refunds?: Refunds | undefined;

  /** SEP-24 `on_change_callback`: URL we POST the transaction to on every status change. */
  onChangeCallback?: string | undefined;
  /** SEP-24 `lang` (RFC 4646), already narrowed to a supported language. */
  lang?: string | undefined;

  customer?: { name: string; email: string } | undefined;

  startedAt: Date;
  updatedAt: Date;
  completedAt?: Date | undefined;
}

export interface ListFilter {
  account: string;
  assetCode?: string | undefined;
  kind?: TransactionKind | undefined;
  limit?: number | undefined;
  noOlderThan?: Date | undefined;
  /** Only transactions whose `startedAt` is strictly before this one (SEP-24 `paging_id`). */
  pagingId?: string | undefined;
}

export type TransactionPatch = Partial<Omit<Transaction, "id" | "startedAt" | "updatedAt">>;

/** Who or what caused a change. Recorded in the audit log. */
export interface AuditContext {
  /** e.g. `user:G...`, `rail:mock`, `escrow-watcher`, `horizon-watcher`, `sandbox`, `system`. */
  actor: string;
  note?: string | undefined;
}

export interface AuditEntry {
  transactionId: string;
  fromStatus: TransactionStatus | null;
  toStatus: TransactionStatus;
  actor: string;
  note?: string | undefined;
  at: Date;
}

/**
 * Persistence boundary. `InMemoryTransactionStore` is for tests and quick local
 * runs; `PostgresTransactionStore` is the durable implementation.
 */
export interface TransactionStore {
  create(tx: Omit<Transaction, "startedAt" | "updatedAt">, audit?: AuditContext): Promise<Transaction>;
  get(id: string): Promise<Transaction | undefined>;
  findByWithdrawMemo(memo: string): Promise<Transaction | undefined>;
  findByEscrowTxId(txIdHex: string): Promise<Transaction | undefined>;
  /**
   * Applies `patch`. When the status changes, an audit entry is written in the
   * same database transaction.
   */
  update(id: string, patch: TransactionPatch, audit?: AuditContext): Promise<Transaction>;
  list(filter: ListFilter): Promise<Transaction[]>;
  auditLog(transactionId: string): Promise<AuditEntry[]>;

  /** Stream cursors (Horizon paging token, Soroban event cursor) so restarts never miss events. */
  getCursor(name: string): Promise<string | undefined>;
  setCursor(name: string, value: string): Promise<void>;

  /**
   * Records a webhook delivery. Returns false if `(provider, eventId)` was seen
   * before, so callers can skip duplicates.
   */
  recordWebhookEvent(provider: string, eventId: string): Promise<boolean>;
  /** Removes a recorded delivery so the provider's retry is processed (used after a server error). */
  forgetWebhookEvent(provider: string, eventId: string): Promise<void>;

  /** Readiness probe: resolves if the store can serve requests. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
