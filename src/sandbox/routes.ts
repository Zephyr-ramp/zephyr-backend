import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { SandboxEscrowGateway } from "../escrow/sandbox.js";
import type { EscrowGateway } from "../escrow/types.js";
import type { EscrowWatcher } from "../escrow/watcher.js";
import { toStroops } from "../lib/amount.js";
import { AnchorError } from "../lib/errors.js";
import { toSep24 } from "../sep24/serialize.js";
import type { TransferService } from "../sep24/service.js";
import type { TransactionStore } from "../store/types.js";

/**
 * Development-only endpoints that simulate real-world events so the full ramp
 * can be exercised without a bank (or, with the sandbox escrow, without a
 * chain). Registered only when ENABLE_SANDBOX=true, which is refused on the
 * public network.
 */
export async function sandboxRoutes(
  app: FastifyInstance,
  {
    config,
    service,
    store,
    escrow,
    escrowWatcher,
  }: {
    config: Config;
    service: TransferService;
    store: TransactionStore;
    escrow?: EscrowGateway | undefined;
    escrowWatcher?: EscrowWatcher | undefined;
  },
) {
  const view = async (id: string) => ({ transaction: toSep24(await service.mustGet(id), config) });

  app.post("/deposits/:id/fiat-received", async (request) => {
    const { id } = request.params as { id: string };
    const tx = await service.handleFiatReceived(id, { audit: { actor: "sandbox" } });
    return { transaction: toSep24(tx, config) };
  });

  app.post("/withdrawals/:id/stellar-payment", async (request) => {
    const { id } = request.params as { id: string };
    const tx = await store.get(id);
    if (!tx || tx.kind !== "withdrawal") throw new AnchorError(404, "withdrawal not found");
    if (!tx.withdrawMemo) throw new AnchorError(409, "withdrawal is not a standard withdrawal awaiting payment");
    const updated = await service.handleStellarPayment(
      {
        transactionHash: `sandbox_${id}`,
        from: tx.from ?? tx.account,
        amount: (request.body as { amount?: string } | undefined)?.amount ?? tx.amountIn!,
        assetCode: tx.assetCode,
        assetIssuer: tx.assetIssuer,
        memo: tx.withdrawMemo,
      },
      { actor: "sandbox" },
    );
    if (!updated) throw new AnchorError(409, `cannot accept payment in status ${tx.status}`);
    return { transaction: toSep24(updated, config) };
  });

  /** Every status transition recorded for a transaction. */
  app.get("/transactions/:id/audit", async (request) => {
    const { id } = request.params as { id: string };
    await service.mustGet(id);
    return { audit: await store.auditLog(id) };
  });

  // Simulated chain: only when running the in-memory sandbox escrow.
  if (escrow instanceof SandboxEscrowGateway) {
    const sandbox = escrow;

    /** Plays the wallet: locks the quoted amount (or `amount`) in the sandbox escrow, then runs the watcher. */
    app.post("/withdrawals/:id/escrow-lock", async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { amount?: string; from?: string; timeout_ledgers?: number };
      const tx = await service.mustGet(id);
      if (tx.withdrawMode !== "escrow" || !tx.escrow) throw new AnchorError(409, "not an escrow withdrawal");
      sandbox.lock({
        txId: tx.escrow.txId,
        user: body.from ?? tx.from ?? tx.account,
        amount: toStroops(body.amount ?? tx.amountIn!),
        timeoutLedgers: body.timeout_ledgers ?? config.escrow.timeoutLedgers,
      });
      await escrowWatcher?.poll();
      return view(id);
    });

    /** Advances the simulated ledger and lets anyone refund an expired escrow. */
    app.post("/withdrawals/:id/escrow-refund", async (request) => {
      const { id } = request.params as { id: string };
      const tx = await service.mustGet(id);
      if (!tx.escrow) throw new AnchorError(409, "not an escrow withdrawal");
      const ledgers = Number((request.body as { advance_ledgers?: number } | undefined)?.advance_ledgers ?? 0);
      if (ledgers > 0) sandbox.advance(ledgers);
      sandbox.refund(tx.escrow.txId);
      await escrowWatcher?.poll();
      return view(id);
    });

    app.post("/escrow/advance", async (request) => {
      const ledgers = Number((request.body as { ledgers?: number } | undefined)?.ledgers ?? 1);
      sandbox.advance(ledgers);
      return { ledger: sandbox.ledger };
    });
  }
}
