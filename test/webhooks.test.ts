import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/lib/signatures.js";
import { WebhookPaymentRail } from "../src/rails/webhook.js";
import { ControllableRail, getTx, startTx, submitApi, testApp, type TestApp } from "./helpers.js";

const SECRET = "whsec_test_0123456789abcdef";

async function send(
  ctx: TestApp,
  event: object,
  opts: { secret?: string; t?: number; provider?: string; key?: string } = {},
) {
  const body = JSON.stringify(event);
  return ctx.app.inject({
    method: "POST",
    url: `/webhooks/rail/${opts.provider ?? "mock"}`,
    headers: {
      "content-type": "application/json",
      "zephyr-signature": signWebhook(opts.secret ?? SECRET, body, opts.t),
      ...(opts.key ? { "idempotency-key": opts.key } : {}),
    },
    payload: body,
  });
}

async function pendingDeposit(ctx: TestApp, amount = "100") {
  const t = await startTx(ctx, "deposit");
  await submitApi(ctx, t.id, t.interactiveToken, { amount });
  return t;
}

describe("webhook signatures", () => {
  it("verifies, and rejects tampering, staleness and malformed headers", () => {
    const body = Buffer.from('{"a":1}');
    const now = 1_700_000_000;
    expect(verifyWebhookSignature(SECRET, body, signWebhook(SECRET, body, now), now)).toEqual({ ok: true });
    expect(verifyWebhookSignature(SECRET, Buffer.from('{"a":2}'), signWebhook(SECRET, body, now), now).ok).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, signWebhook(SECRET, body, now - 301), now)).toEqual({
      ok: false,
      reason: "stale signature",
    });
    expect(verifyWebhookSignature(SECRET, body, "garbage", now).ok).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, undefined, now)).toEqual({ ok: false, reason: "missing signature" });
    expect(verifyWebhookSignature("other-secret-value", body, signWebhook(SECRET, body, now), now).ok).toBe(false);
  });
});

describe("POST /webhooks/rail/:provider", () => {
  it("is not registered without RAIL_WEBHOOK_SECRET", async () => {
    const ctx = await testApp();
    expect((await send(ctx, { id: "e1" })).statusCode).toBe(404);
  });

  it("completes a deposit on deposit.received", async () => {
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: SECRET });
    const { id, token } = await pendingDeposit(ctx);
    const res = await send(ctx, {
      id: "evt_1",
      type: "deposit.received",
      data: { transaction_id: id, amount: "100.00" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });
    expect((await getTx(ctx, token, id)).status).toBe("completed");
    const audit = await ctx.store.auditLog(id);
    expect(audit.find((a) => a.toStatus === "pending_anchor")?.actor).toBe("rail:mock");
  });

  it("moves a deposit with the wrong amount to error, never paying", async () => {
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: SECRET });
    const { id, token } = await pendingDeposit(ctx);
    await send(ctx, { id: "evt_2", type: "deposit.received", data: { transaction_id: id, amount: "99.99" } });
    const tx = await getTx(ctx, token, id);
    expect(tx.status).toBe("error");
    expect(tx.message).toMatch(/expected 100.00/);
    expect(ctx.stellar.sent).toEqual([]);
  });

  it("processes each event once (idempotency)", async () => {
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: SECRET });
    const { id } = await pendingDeposit(ctx);
    const event = { id: "evt_dup", type: "deposit.received", data: { transaction_id: id, amount: "100" } };
    expect((await send(ctx, event)).json().duplicate).toBe(false);
    expect((await send(ctx, event)).json()).toEqual({ received: true, duplicate: true });
    expect(ctx.stellar.sent).toHaveLength(1);
  });

  it("uses the Idempotency-Key header when present", async () => {
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: SECRET });
    const { id } = await pendingDeposit(ctx);
    await send(ctx, { id: "a", type: "deposit.received", data: { transaction_id: id, amount: "100" } }, { key: "k1" });
    const again = await send(
      ctx,
      { id: "b", type: "deposit.received", data: { transaction_id: id, amount: "100" } },
      { key: "k1" },
    );
    expect(again.json().duplicate).toBe(true);
  });

  it("rejects bad signatures, stale timestamps, bad bodies and unknown providers", async () => {
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: SECRET });
    const event = { id: "x", type: "payout.failed", data: { transaction_id: "t" } };
    expect((await send(ctx, event, { secret: "wrong-secret-0000000" })).statusCode).toBe(401);
    expect((await send(ctx, event, { t: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    expect((await send(ctx, event, { provider: "otherbank" })).statusCode).toBe(404);
    expect((await send(ctx, { id: "y", type: "unknown.event", data: {} })).statusCode).toBe(400);
    const notJson = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/rail/mock",
      headers: { "content-type": "application/json", "zephyr-signature": signWebhook(SECRET, "{nope") },
      payload: "{nope",
    });
    expect(notJson.statusCode).toBe(400);
  });

  it("returns 409 for events that don't fit the transaction's state, and keeps them recorded", async () => {
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: SECRET });
    const { id } = await pendingDeposit(ctx);
    const res = await send(ctx, { id: "p1", type: "payout.completed", data: { transaction_id: id } });
    expect(res.statusCode).toBe(409);
    expect(await ctx.store.recordWebhookEvent("mock", "p1")).toBe(false);
  });

  it("settles asynchronous standard payouts with payout.completed / payout.failed", async () => {
    const rail = new ControllableRail();
    rail.payoutMode = "pending";
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: SECRET }, { rail });

    const ok = await startTx(ctx, "withdraw");
    await submitApi(ctx, ok.id, ok.interactiveToken, { amount: "50" });
    await ctx.app.inject({ method: "POST", url: `/sandbox/withdrawals/${ok.id}/stellar-payment` });
    expect((await getTx(ctx, ok.token, ok.id)).status).toBe("pending_external");
    await send(ctx, { id: "po1", type: "payout.completed", data: { transaction_id: ok.id, external_id: "bank_42" } });
    const done = await getTx(ctx, ok.token, ok.id);
    expect(done.status).toBe("completed");
    expect(done.external_transaction_id).toBe("bank_42");

    const bad = await startTx(ctx, "withdraw");
    await submitApi(ctx, bad.id, bad.interactiveToken, { amount: "50" });
    await ctx.app.inject({ method: "POST", url: `/sandbox/withdrawals/${bad.id}/stellar-payment` });
    await send(ctx, { id: "po2", type: "payout.failed", data: { transaction_id: bad.id, reason: "account closed" } });
    const failed = await getTx(ctx, bad.token, bad.id);
    expect(failed.status).toBe("error");
    expect(failed.message).toMatch(/account closed/);
  });
});

describe("WebhookPaymentRail skeleton", () => {
  it("calls the provider API with auth and idempotency keys, and reports payouts as pending", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.endsWith("/deposit-instructions")
        ? { id: "dep_1", instructions: { iban: "X" } }
        : { id: "po_1" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const rail = new WebhookPaymentRail({ apiUrl: "https://bank.example/v1/", apiKey: "k", fetch: fakeFetch });
    const customer = { name: "Ada", email: "a@b.co" };

    expect(await rail.createDepositInstructions({ transactionId: "t1", amount: "10", customer })).toEqual({
      externalId: "dep_1",
      instructions: { iban: "X" },
    });
    expect(await rail.sendPayout({ transactionId: "t1", amount: "9", customer })).toEqual({
      externalId: "po_1",
      status: "pending",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://bank.example/v1/deposit-instructions",
      "https://bank.example/v1/payouts",
    ]);
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(headers["idempotency-key"]).toBe("payout-t1");
  });

  it("throws on provider errors", async () => {
    const rail = new WebhookPaymentRail({
      apiUrl: "https://bank.example",
      apiKey: "k",
      fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(
      rail.sendPayout({ transactionId: "t", amount: "1", customer: { name: "a", email: "b" } }),
    ).rejects.toThrow(/500/);
  });
});
