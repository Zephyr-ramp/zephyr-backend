import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { EscrowEvent, EscrowGateway } from "../escrow/types.js";
import { escrowTxId } from "../escrow/types.js";
import { calculateFee, compare, fromStroops, isValidAmount, subtract, toStroops } from "../lib/amount.js";
import { AnchorError } from "../lib/errors.js";
import type { CallbackNotifier } from "../notify/callbacks.js";
import type { PaymentRail } from "../rails/types.js";
import type { IncomingPayment, StellarGateway } from "../stellar/gateway.js";
import type {
  AuditContext,
  Refunds,
  Transaction,
  TransactionKind,
  TransactionPatch,
  TransactionStatus,
  TransactionStore,
  WithdrawMode,
} from "../store/types.js";
import { toSep24 } from "./serialize.js";
import { assertTransition } from "./state.js";

type Logger = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

const SYSTEM: AuditContext = { actor: "system" };

/**
 * The on/off-ramp business logic. Every status change goes through
 * `transition`, which checks it against the state machine in `state.ts`,
 * writes an audit entry and notifies the wallet's `on_change_callback`.
 *
 * Money safety: amounts are decimal strings / BigInt stroops, and any mismatch
 * or unexpected state moves the transaction to `error` for manual review. It is
 * never paid automatically.
 */
export class TransferService {
  constructor(
    private readonly config: Config,
    private readonly store: TransactionStore,
    private readonly rail: PaymentRail,
    private readonly stellar: StellarGateway,
    private readonly log: Logger,
    private readonly escrow?: EscrowGateway,
    private readonly notifier?: CallbackNotifier,
  ) {}

  get escrowEnabled(): boolean {
    return this.escrow !== undefined;
  }

  /** Contract ID of the active escrow (the deployed contract, or the sandbox one). */
  get escrowContractId(): string | undefined {
    return this.escrow?.contractId;
  }

  async start(input: {
    kind: TransactionKind;
    account: string;
    accountMemo?: string | undefined;
    clientDomain?: string | undefined;
    assetCode: string;
    amount?: string | undefined;
    stellarAccount?: string | undefined;
    lang?: string | undefined;
    onChangeCallback?: string | undefined;
  }): Promise<Transaction> {
    if (input.assetCode !== this.config.asset.code) {
      throw new AnchorError(400, `unsupported asset_code: ${input.assetCode}`);
    }
    if (input.amount !== undefined) this.assertAmount(input.kind, input.amount);

    const stellarAccount = input.stellarAccount ?? input.account;
    return this.store.create(
      {
        id: randomUUID(),
        kind: input.kind,
        status: "incomplete",
        account: input.account,
        accountMemo: input.accountMemo,
        clientDomain: input.clientDomain,
        assetCode: this.config.asset.code,
        assetIssuer: this.config.asset.issuer,
        amountIn: input.amount,
        lang: input.lang,
        onChangeCallback: input.onChangeCallback,
        ...(input.kind === "deposit" ? { to: stellarAccount } : { from: stellarAccount }),
      },
      { actor: `user:${input.account}` },
    );
  }

  /** The fee and amount the user would receive, using the same formula as the interactive form. */
  quote(amount: string) {
    const amountFee = calculateFee(amount, this.config.fee.fixed, this.config.fee.percent);
    return { amountFee, amountOut: subtract(amount, amountFee) };
  }

  /** Called when the user submits the interactive (KYC + amount) form. */
  async submitInteractive(
    id: string,
    form: { amount: string; name: string; email: string; withdrawMode?: WithdrawMode | undefined },
  ): Promise<Transaction> {
    const tx = await this.mustGet(id);
    if (tx.status !== "incomplete") throw new AnchorError(400, "transaction is no longer editable");
    this.assertAmount(tx.kind, form.amount);
    if (!form.name.trim()) throw new AnchorError(400, "name is required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) throw new AnchorError(400, "a valid email is required");

    const customer = { name: form.name.trim(), email: form.email.trim() };
    const { amountFee, amountOut } = this.quote(form.amount);
    if (compare(amountOut, "0") <= 0) throw new AnchorError(400, "amount does not cover the fee");

    const amountIn = fromStroops(toStroops(form.amount));
    const base = { amountIn, amountFee, amountOut, customer };
    const actor = { actor: `user:${tx.account}`, note: "interactive form submitted" };

    if (tx.kind === "deposit") {
      const { instructions, externalId } = await this.rail.createDepositInstructions({
        transactionId: tx.id,
        amount: form.amount,
        customer,
      });
      return this.transition(
        tx,
        "pending_user_transfer_start",
        { ...base, depositInstructions: instructions, externalTransactionId: externalId },
        actor,
      );
    }

    if (form.withdrawMode === "escrow") {
      if (!this.escrow) throw new AnchorError(400, "escrow withdrawals are not enabled on this anchor");
      return this.transition(
        { ...tx, withdrawMode: "escrow" },
        "pending_user_transfer_start",
        {
          ...base,
          withdrawMode: "escrow",
          escrow: { contractId: this.escrow.contractId, txId: escrowTxId(tx.id) },
        },
        actor,
      );
    }

    return this.transition(
      tx,
      "pending_user_transfer_start",
      {
        ...base,
        withdrawMode: "standard",
        withdrawAnchorAccount: this.config.distributionKeypair.publicKey(),
        // Text memos are capped at 28 bytes; 24 hex chars is unique enough to match payments.
        withdrawMemo: randomBytes(12).toString("hex"),
      },
      actor,
    );
  }

  // ---------------------------------------------------------------- deposits

  /**
   * On-ramp: the payment rail confirmed the user's dollars arrived. Sends USDC on Stellar.
   * `amount`, when the rail reports it, must match what the user was quoted.
   */
  async handleFiatReceived(
    id: string,
    opts: { amount?: string | undefined; audit?: AuditContext } = {},
  ): Promise<Transaction> {
    const audit = opts.audit ?? { actor: `rail:${this.rail.name}` };
    const tx = await this.mustGet(id);
    if (tx.kind !== "deposit") throw new AnchorError(400, "not a deposit");
    if (tx.status !== "pending_user_transfer_start") {
      throw new AnchorError(409, `cannot confirm fiat in status ${tx.status}`);
    }
    let current = await this.transition(tx, "pending_anchor", {}, audit);

    if (opts.amount !== undefined && (!isValidAmount(opts.amount) || compare(opts.amount, tx.amountIn!) !== 0)) {
      this.log.error({ id, expected: tx.amountIn, got: opts.amount }, "deposit amount mismatch");
      return this.transition(
        current,
        "error",
        { message: `received ${opts.amount} USD, expected ${tx.amountIn}; needs manual review` },
        audit,
      );
    }

    current = await this.transition(current, "pending_stellar", {}, SYSTEM);
    try {
      const hash = await this.stellar.sendPayment({
        destination: tx.to!,
        amount: tx.amountOut!,
        memo: tx.accountMemo,
      });
      this.log.info({ id, hash }, "deposit completed");
      return this.transition(current, "completed", { stellarTransactionId: hash, completedAt: new Date() }, SYSTEM);
    } catch (err) {
      this.log.error({ id, err }, "deposit payout on Stellar failed");
      return this.transition(current, "error", { message: "Stellar payment failed; needs manual review" }, SYSTEM);
    }
  }

  // ---------------------------------------------------- standard withdrawals

  /** Off-ramp: USDC arrived at the distribution account with a memo. Pays dollars out via the rail. */
  async handleStellarPayment(
    payment: IncomingPayment,
    audit: AuditContext = { actor: "horizon-watcher" },
  ): Promise<Transaction | undefined> {
    if (!payment.memo) return undefined;
    const tx = await this.store.findByWithdrawMemo(payment.memo);
    if (!tx || tx.status !== "pending_user_transfer_start" || tx.withdrawMode === "escrow") return undefined;

    const current = await this.transition(
      tx,
      "pending_anchor",
      { stellarTransactionId: payment.transactionHash, from: payment.from },
      audit,
    );

    const wrongAsset = payment.assetCode !== tx.assetCode || payment.assetIssuer !== tx.assetIssuer;
    if (wrongAsset || compare(payment.amount, tx.amountIn!) !== 0) {
      this.log.error({ id: tx.id, expected: tx.amountIn, got: payment.amount }, "withdrawal amount mismatch");
      return this.transition(
        current,
        "error",
        { message: `received ${payment.amount}, expected ${tx.amountIn}; needs manual review` },
        audit,
      );
    }

    return this.payOut(current);
  }

  // ------------------------------------------------------ escrow withdrawals

  /** The user locked funds in the escrow contract. Verify, then pay out fiat. */
  async handleEscrowLocked(event: Extract<EscrowEvent, { type: "locked" }>): Promise<Transaction | undefined> {
    const audit = { actor: "escrow-watcher", note: `locked in ${event.txHash}` };
    const tx = await this.store.findByEscrowTxId(event.txId);
    if (!tx) {
      // Not ours (or a squatted tx_id). The user can refund after expiry.
      this.log.warn({ txId: event.txId }, "escrow lock for unknown transaction; ignoring");
      return undefined;
    }
    if (tx.escrow?.lockTxHash === event.txHash || tx.status !== "pending_user_transfer_start") {
      if (tx.escrow?.lockTxHash !== event.txHash) {
        this.log.warn({ id: tx.id, status: tx.status }, "escrow lock in unexpected status; ignoring");
      }
      return tx; // replayed event, already handled
    }

    const escrow = { ...tx.escrow!, user: event.user, expiresLedger: event.expiresLedger, lockTxHash: event.txHash };
    const current = await this.transition(
      tx,
      "pending_anchor",
      { escrow, stellarTransactionId: event.txHash, from: event.user },
      audit,
    );

    // Money safety: the lock must be exactly what was quoted, from the expected account.
    const expected = toStroops(tx.amountIn!);
    if (event.amount !== expected || (tx.from && tx.from !== event.user)) {
      this.log.error(
        { id: tx.id, expected: expected.toString(), got: event.amount.toString(), from: event.user },
        "escrow lock mismatch",
      );
      return this.transition(
        current,
        "error",
        {
          message: `escrow locked ${fromStroops(event.amount)} from ${event.user}, expected ${tx.amountIn} from ${tx.from}; needs manual review. The user can refund after ledger ${event.expiresLedger}.`,
        },
        audit,
      );
    }

    const latest = await this.escrow!.latestLedger();
    if (latest >= event.expiresLedger) {
      // Already expired (we saw the lock late): we can't claim and the user may
      // have refunded already. Their `refunded` event completes the transaction.
      this.log.warn({ id: tx.id, expiresLedger: event.expiresLedger, latest }, "escrow expired before processing");
      return this.store.update(current.id, {
        message: `escrow expired at ledger ${event.expiresLedger} before it was processed; refund it to get your USDC back`,
      });
    }
    // Don't start a payout we might not be able to claim before expiry.
    if (event.expiresLedger - latest < this.config.escrow.minRemainingLedgers) {
      this.log.warn({ id: tx.id, expiresLedger: event.expiresLedger, latest }, "escrow expires too soon; cancelling");
      return this.cancelEscrow(current, "escrow expires too soon to pay out safely");
    }

    return this.payOut(current);
  }

  /** Seen on chain: the anchor's claim landed. Confirms a claim whose response we may have missed. */
  async handleEscrowClaimed(event: Extract<EscrowEvent, { type: "claimed" }>): Promise<Transaction | undefined> {
    const tx = await this.store.findByEscrowTxId(event.txId);
    if (!tx || tx.status !== "pending_stellar") return tx;
    return this.transition(
      tx,
      "completed",
      { escrow: { ...tx.escrow!, claimTxHash: event.txHash }, completedAt: new Date() },
      { actor: "escrow-watcher", note: `claimed in ${event.txHash}` },
    );
  }

  /** Seen on chain: funds went back to the user (our `cancel`, or the user's `refund`). */
  async handleEscrowRefunded(event: Extract<EscrowEvent, { type: "refunded" }>): Promise<Transaction | undefined> {
    const tx = await this.store.findByEscrowTxId(event.txId);
    if (!tx || tx.status === "refunded") return tx;
    const audit = { actor: "escrow-watcher", note: `refunded in ${event.txHash}` };

    if (tx.status === "pending_external" || tx.status === "pending_stellar") {
      // A fiat payout may already have left. Needs a human.
      this.log.error({ id: tx.id, status: tx.status }, "escrow refunded while payout in progress");
      return this.transition(
        tx,
        "error",
        {
          escrow: { ...tx.escrow!, refundTxHash: event.txHash },
          message: `escrow was refunded on chain while the payout was ${tx.status}; needs manual review`,
        },
        audit,
      );
    }
    if (tx.status !== "pending_user_transfer_start" && tx.status !== "pending_anchor") return tx;

    return this.transition(
      tx,
      "refunded",
      {
        escrow: { ...tx.escrow!, refundTxHash: event.txHash },
        refunds: refundsFor(fromStroops(event.amount), event.txHash),
        message: event.byAnchor ? "cancelled by the anchor" : "refunded to the user after the escrow expired",
      },
      audit,
    );
  }

  // --------------------------------------------------------------- payouts

  /** Result of an asynchronous payout, reported by the rail's webhook. */
  async handlePayoutResult(
    id: string,
    result: { ok: true; externalId?: string | undefined } | { ok: false; reason?: string | undefined },
    audit: AuditContext = { actor: `rail:${this.rail.name}` },
  ): Promise<Transaction> {
    const tx = await this.mustGet(id);
    if (tx.kind !== "withdrawal" || tx.status !== "pending_external") {
      throw new AnchorError(409, `cannot record a payout result in status ${tx.status}`);
    }
    if (result.ok) {
      const patched = result.externalId
        ? await this.store.update(tx.id, { externalTransactionId: result.externalId })
        : tx;
      return this.afterPayout(patched, audit);
    }
    this.log.error({ id, reason: result.reason }, "fiat payout failed");
    return this.payoutFailed(tx, result.reason ?? "payout failed", audit);
  }

  private async payOut(tx: Transaction): Promise<Transaction> {
    const current = await this.transition(tx, "pending_external", {}, SYSTEM);
    let payout: Awaited<ReturnType<PaymentRail["sendPayout"]>>;
    try {
      payout = await this.rail.sendPayout({ transactionId: tx.id, amount: tx.amountOut!, customer: tx.customer! });
    } catch (err) {
      this.log.error({ id: tx.id, err }, "fiat payout failed");
      return this.payoutFailed(current, "fiat payout failed", { actor: `rail:${this.rail.name}` });
    }
    const withId = await this.store.update(current.id, { externalTransactionId: payout.externalId });
    if (payout.status === "pending") {
      this.log.info({ id: tx.id, externalId: payout.externalId }, "payout pending; waiting for rail webhook");
      return withId;
    }
    return this.afterPayout(withId, { actor: `rail:${this.rail.name}` });
  }

  /** Fiat has left. Standard: done. Escrow: claim the locked USDC first. */
  private async afterPayout(tx: Transaction, audit: AuditContext): Promise<Transaction> {
    if (tx.withdrawMode !== "escrow") {
      this.log.info({ id: tx.id }, "withdrawal completed");
      return this.transition(tx, "completed", { completedAt: new Date() }, audit);
    }

    const claiming = await this.transition(tx, "pending_stellar", {}, audit);
    try {
      const hash = await this.escrow!.claim(tx.escrow!.txId);
      this.log.info({ id: tx.id, hash }, "escrow claimed; withdrawal completed");
      return this.transition(
        claiming,
        "completed",
        { escrow: { ...claiming.escrow!, claimTxHash: hash }, completedAt: new Date() },
        { actor: "escrow", note: `claimed in ${hash}` },
      );
    } catch (err) {
      this.log.error({ id: tx.id, err }, "escrow claim failed after payout");
      return this.transition(
        claiming,
        "error",
        {
          message: `fiat paid out but escrow claim failed (${(err as Error).message}); retry claim before ledger ${claiming.escrow?.expiresLedger}`,
        },
        SYSTEM,
      );
    }
  }

  private async payoutFailed(tx: Transaction, reason: string, audit: AuditContext): Promise<Transaction> {
    if (tx.withdrawMode === "escrow") return this.cancelEscrow(tx, reason);
    // Standard withdrawal: the anchor holds the user's USDC. A human decides how to refund.
    return this.transition(tx, "error", { message: `${reason}; needs manual review` }, audit);
  }

  /** Returns escrowed funds to the user on chain. */
  private async cancelEscrow(tx: Transaction, reason: string): Promise<Transaction> {
    try {
      const hash = await this.escrow!.cancel(tx.escrow!.txId);
      this.log.info({ id: tx.id, hash, reason }, "escrow cancelled; user refunded");
      return this.transition(
        tx,
        "refunded",
        {
          escrow: { ...tx.escrow!, refundTxHash: hash },
          refunds: refundsFor(tx.amountIn!, hash),
          message: `${reason}; your USDC was returned`,
        },
        { actor: "escrow", note: `cancelled in ${hash}` },
      );
    } catch (err) {
      this.log.error({ id: tx.id, err }, "escrow cancel failed");
      return this.transition(
        tx,
        "error",
        {
          message: `${reason}, and cancelling the escrow failed; the user can refund after ledger ${tx.escrow?.expiresLedger}`,
        },
        SYSTEM,
      );
    }
  }

  // ------------------------------------------------------------ helpers

  async getForAccount(id: string, account: string): Promise<Transaction> {
    const tx = await this.store.get(id);
    if (!tx || tx.account !== account) throw new AnchorError(404, "transaction not found");
    return tx;
  }

  async mustGet(id: string): Promise<Transaction> {
    const tx = await this.store.get(id);
    if (!tx) throw new AnchorError(404, "transaction not found");
    return tx;
  }

  /** Validated, audited, notified status change. */
  private async transition(
    tx: Transaction,
    to: TransactionStatus,
    patch: TransactionPatch,
    audit: AuditContext,
  ): Promise<Transaction> {
    assertTransition(tx, to);
    const updated = await this.store.update(tx.id, { ...patch, status: to }, audit);
    if (updated.onChangeCallback && to !== tx.status) {
      this.notifier?.notify(updated.onChangeCallback, { transaction: toSep24(updated, this.config) });
    }
    return updated;
  }

  private assertAmount(kind: TransactionKind, amount: string) {
    if (!isValidAmount(amount)) throw new AnchorError(400, "invalid amount");
    const { min, max } = kind === "deposit" ? this.config.limits.deposit : this.config.limits.withdraw;
    if (compare(amount, min) < 0 || compare(amount, max) > 0) {
      throw new AnchorError(400, `amount must be between ${min} and ${max}`);
    }
  }
}

function refundsFor(amount: string, stellarTxHash: string): Refunds {
  return {
    amount_refunded: amount,
    amount_fee: "0.00",
    payments: [{ id: stellarTxHash, id_type: "stellar", amount, fee: "0.00" }],
  };
}
