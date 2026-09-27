import type { Config } from "../config.js";
import { moreInfoToken } from "../lib/signatures.js";
import type { Transaction } from "../store/types.js";

export function moreInfoUrl(config: Config, id: string): string {
  const url = new URL(`${config.baseUrl}/sep24/transaction/more_info`);
  url.searchParams.set("id", id);
  url.searchParams.set("token", moreInfoToken(config.jwtSecret, id));
  return url.toString();
}

/** Shape a stored transaction into the SEP-24 `transaction` object. */
export function toSep24(tx: Transaction, config: Config) {
  const base = {
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    more_info_url: moreInfoUrl(config, tx.id),
    amount_in: tx.amountIn ?? null,
    amount_out: tx.amountOut ?? null,
    amount_fee: tx.amountFee ?? null,
    amount_in_asset: tx.kind === "deposit" ? "iso4217:USD" : `stellar:${tx.assetCode}:${tx.assetIssuer}`,
    amount_out_asset: tx.kind === "deposit" ? `stellar:${tx.assetCode}:${tx.assetIssuer}` : "iso4217:USD",
    started_at: tx.startedAt.toISOString(),
    updated_at: tx.updatedAt.toISOString(),
    completed_at: tx.completedAt?.toISOString() ?? null,
    stellar_transaction_id: tx.stellarTransactionId ?? null,
    external_transaction_id: tx.externalTransactionId ?? null,
    message: tx.message ?? null,
    refunded: tx.status === "refunded" || tx.refunds !== undefined,
    ...(tx.refunds ? { refunds: tx.refunds } : {}),
  };

  if (tx.kind === "deposit") {
    return {
      ...base,
      to: tx.to ?? null,
      deposit_memo: tx.accountMemo ?? null,
      deposit_memo_type: tx.accountMemo ? "id" : null,
    };
  }
  return {
    ...base,
    from: tx.from ?? null,
    withdraw_anchor_account: tx.withdrawAnchorAccount ?? null,
    withdraw_memo: tx.withdrawMemo ?? null,
    withdraw_memo_type: tx.withdrawMemo ? "text" : null,
    // Zephyr extension (ignored by other wallets): how to fund an escrow withdrawal.
    ...(tx.withdrawMode === "escrow" && tx.escrow
      ? {
          withdraw_mode: "escrow" as const,
          escrow: {
            contract_id: tx.escrow.contractId,
            tx_id: tx.escrow.txId,
            amount: tx.amountIn ?? null,
            timeout_ledgers: config.escrow.timeoutLedgers,
            expires_ledger: tx.escrow.expiresLedger ?? null,
            lock_tx_hash: tx.escrow.lockTxHash ?? null,
            claim_tx_hash: tx.escrow.claimTxHash ?? null,
            refund_tx_hash: tx.escrow.refundTxHash ?? null,
          },
        }
      : { withdraw_mode: "standard" as const }),
  };
}

export type Sep24Transaction = ReturnType<typeof toSep24>;
