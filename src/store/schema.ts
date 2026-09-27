import { index, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { EscrowInfo, Refunds, TransactionKind, TransactionStatus, WithdrawMode } from "./types.js";

/**
 * Database schema. After changing it, run `npm run db:generate` and commit the
 * generated SQL in `drizzle/`. Amounts are stored as decimal strings (never floats).
 */
export const transactions = pgTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<TransactionKind>().notNull(),
    status: text("status").$type<TransactionStatus>().notNull(),
    account: text("account").notNull(),
    accountMemo: text("account_memo"),
    clientDomain: text("client_domain"),
    assetCode: text("asset_code").notNull(),
    assetIssuer: text("asset_issuer").notNull(),
    amountIn: text("amount_in"),
    amountOut: text("amount_out"),
    amountFee: text("amount_fee"),
    to: text("to_account"),
    from: text("from_account"),
    withdrawAnchorAccount: text("withdraw_anchor_account"),
    withdrawMemo: text("withdraw_memo"),
    withdrawMode: text("withdraw_mode").$type<WithdrawMode>(),
    escrowTxId: text("escrow_tx_id"),
    escrow: jsonb("escrow").$type<EscrowInfo>(),
    depositInstructions: jsonb("deposit_instructions").$type<Record<string, string>>(),
    stellarTransactionId: text("stellar_transaction_id"),
    externalTransactionId: text("external_transaction_id"),
    message: text("message"),
    refunds: jsonb("refunds").$type<Refunds>(),
    onChangeCallback: text("on_change_callback"),
    lang: text("lang"),
    customer: jsonb("customer").$type<{ name: string; email: string }>(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("transactions_account_started_idx").on(t.account, t.startedAt),
    uniqueIndex("transactions_withdraw_memo_idx").on(t.withdrawMemo),
    uniqueIndex("transactions_escrow_tx_id_idx").on(t.escrowTxId),
  ],
);

/** One row per status transition: who/what changed it, and when. Append-only. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id),
    fromStatus: text("from_status").$type<TransactionStatus>(),
    toStatus: text("to_status").$type<TransactionStatus>().notNull(),
    actor: text("actor").notNull(),
    note: text("note"),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_transaction_idx").on(t.transactionId, t.id)],
);

/** Horizon paging tokens and Soroban event cursors, so restarts resume where they stopped. */
export const cursors = pgTable("cursors", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** Seen webhook deliveries, for idempotency. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);
