import { describe, expect, it } from "vitest";
import { bearer, getTx, startTx, submitApi, testApp } from "./helpers.js";

/**
 * End-to-end over HTTP with the sandbox: the same calls a wallet, the
 * interactive pages and the bank would make. Only Horizon is faked; the escrow
 * runs on the in-memory sandbox chain.
 */
describe("end-to-end sandbox flows", () => {
  it("deposit: USD in, USDC out", async () => {
    const ctx = await testApp();
    const { id, token, interactiveToken, client } = await startTx(ctx, "deposit");

    const form = await submitApi(ctx, id, interactiveToken, { amount: "250" });
    expect(form.json().deposit_instructions.amount).toBe("250 USD");
    expect((await getTx(ctx, token, id)).status).toBe("pending_user_transfer_start");

    await ctx.app.inject({ method: "POST", url: `/sandbox/deposits/${id}/fiat-received` });
    const tx = await getTx(ctx, token, id);
    expect(tx).toMatchObject({ status: "completed", amount_in: "250.00", amount_fee: "3.00", amount_out: "247.00" });
    expect(ctx.stellar.sent).toEqual([{ destination: client.publicKey(), amount: "247.00", memo: undefined }]);

    const audit = (await ctx.app.inject({ method: "GET", url: `/sandbox/transactions/${id}/audit` })).json().audit;
    expect(audit.map((a: { toStatus: string; actor: string }) => `${a.toStatus}:${a.actor}`)).toEqual([
      `incomplete:user:${client.publicKey()}`,
      `pending_user_transfer_start:user:${client.publicKey()}`,
      "pending_anchor:sandbox",
      "pending_stellar:system",
      "completed:system",
    ]);
  });

  it("standard withdrawal: USDC payment with memo, USD out", async () => {
    const ctx = await testApp();
    const { id, token, interactiveToken } = await startTx(ctx, "withdraw");
    await submitApi(ctx, id, interactiveToken, { amount: "75" });

    let tx = await getTx(ctx, token, id);
    expect(tx).toMatchObject({
      status: "pending_user_transfer_start",
      withdraw_mode: "standard",
      withdraw_memo_type: "text",
    });
    expect(tx.withdraw_anchor_account).toBe(ctx.config.distributionKeypair.publicKey());

    await ctx.app.inject({ method: "POST", url: `/sandbox/withdrawals/${id}/stellar-payment` });
    tx = await getTx(ctx, token, id);
    expect(tx).toMatchObject({ status: "completed", amount_out: "73.75" });
    expect(tx.external_transaction_id).toMatch(/^mock_payout_/);
  });

  it("escrow withdrawal: lock in the contract, USD out, anchor claims", async () => {
    const ctx = await testApp();
    const { id, token, interactiveToken } = await startTx(ctx, "withdraw", { withdraw_mode: "escrow" });
    await submitApi(ctx, id, interactiveToken, { amount: "40", withdraw_mode: "escrow" });

    let tx = await getTx(ctx, token, id);
    expect(tx.escrow).toMatchObject({ contract_id: "SANDBOX_ESCROW", amount: "40.00" });

    const lock = await ctx.app.inject({ method: "POST", url: `/sandbox/withdrawals/${id}/escrow-lock` });
    expect(lock.statusCode).toBe(200);
    tx = await getTx(ctx, token, id);
    expect(tx.status).toBe("completed");
    expect(tx.escrow.lock_tx_hash).toMatch(/^sandbox_/);
    expect(tx.escrow.claim_tx_hash).toMatch(/^sandbox_/);
  });

  it("escrow withdrawal refunded by the user after expiry", async () => {
    const ctx = await testApp();
    const { id, token, interactiveToken } = await startTx(ctx, "withdraw");
    await submitApi(ctx, id, interactiveToken, { amount: "40", withdraw_mode: "escrow" });
    // The anchor misses the lock until after expiry: lock directly on the sandbox chain.
    const escrow = ctx.escrow as import("../src/escrow/sandbox.js").SandboxEscrowGateway;
    const tx0 = await getTx(ctx, token, id);
    escrow.lock({ txId: tx0.escrow.tx_id, user: tx0.from, amount: 400_000_000n, timeoutLedgers: 720 });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/sandbox/withdrawals/${id}/escrow-refund`,
      payload: { advance_ledgers: 720 },
    });
    expect(res.statusCode).toBe(200);
    // The watcher sees the (already expired) lock, then the user's refund.
    const tx = await getTx(ctx, token, id);
    expect(tx.status).toBe("refunded");
    expect(tx.refunds.amount_refunded).toBe("40.00");
    expect(tx.escrow.refund_tx_hash).toMatch(/^sandbox_/);
  });

  it("wallets can list their history", async () => {
    const ctx = await testApp();
    const { token, client } = await startTx(ctx, "deposit");
    await startTx(ctx, "withdraw", {}, client);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/sep24/transactions?asset_code=USDC",
      headers: bearer(token),
    });
    expect(res.json().transactions.map((t: { kind: string }) => t.kind)).toEqual(["withdrawal", "deposit"]);
  });
});
