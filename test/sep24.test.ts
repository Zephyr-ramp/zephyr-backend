import { describe, expect, it } from "vitest";
import { authenticate, testApp } from "./helpers.js";

async function startInteractive(kind: "deposit" | "withdraw", amount = "100") {
  const ctx = await testApp();
  const { token, client } = await authenticate(ctx.app);
  const res = await ctx.app.inject({
    method: "POST",
    url: `/sep24/transactions/${kind}/interactive`,
    headers: { authorization: `Bearer ${token}` },
    payload: { asset_code: "USDC" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const url = new URL(body.url);
  const interactiveToken = url.searchParams.get("token")!;

  const submit = await ctx.app.inject({
    method: "POST",
    url: "/sep24/interactive",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      transaction_id: body.id,
      token: interactiveToken,
      amount,
      name: "Ada Lovelace",
      email: "ada@example.com",
    }).toString(),
  });
  return { ...ctx, token, client, id: body.id as string, submit, interactiveToken };
}

async function getTx(app: Awaited<ReturnType<typeof testApp>>["app"], token: string, id: string) {
  const res = await app.inject({
    method: "GET",
    url: `/sep24/transaction?id=${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json().transaction;
}

describe("SEP-24", () => {
  it("exposes /info", async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: "GET", url: "/sep24/info" });
    expect(res.json().deposit.USDC.enabled).toBe(true);
    expect(res.json().withdraw.USDC.enabled).toBe(true);
  });

  it("requires SEP-10 auth", async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/sep24/transactions/deposit/interactive",
      payload: { asset_code: "USDC" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe("authentication_required");
  });

  it("rejects unsupported assets", async () => {
    const { app } = await testApp();
    const { token } = await authenticate(app);
    const res = await app.inject({
      method: "POST",
      url: "/sep24/transactions/deposit/interactive",
      headers: { authorization: `Bearer ${token}` },
      payload: { asset_code: "BTC" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs a full deposit: USD in, USDC out on Stellar", async () => {
    const { app, token, client, id, submit, stellar } = await startInteractive("deposit", "100");
    expect(submit.statusCode).toBe(200);
    expect(submit.body).toContain("Send your dollars");

    let tx = await getTx(app, token, id);
    expect(tx.status).toBe("pending_user_transfer_start");
    expect(tx.amount_in).toBe("100.00");
    expect(tx.amount_fee).toBe("1.50"); // 0.50 fixed + 1%
    expect(tx.amount_out).toBe("98.50");

    const confirm = await app.inject({ method: "POST", url: `/sandbox/deposits/${id}/fiat-received` });
    expect(confirm.statusCode).toBe(200);

    tx = await getTx(app, token, id);
    expect(tx.status).toBe("completed");
    expect(tx.stellar_transaction_id).toBe("fakehash1");
    expect(stellar.sent).toEqual([{ destination: client.publicKey(), amount: "98.50", memo: undefined }]);
  });

  it("marks a deposit as error if the Stellar payment fails", async () => {
    const { app, token, id, stellar } = await startInteractive("deposit");
    stellar.fail = true;
    await app.inject({ method: "POST", url: `/sandbox/deposits/${id}/fiat-received` });
    expect((await getTx(app, token, id)).status).toBe("error");
  });

  it("runs a full withdrawal: USDC in, USD out via the rail", async () => {
    const { app, token, id, config } = await startInteractive("withdraw", "50");
    let tx = await getTx(app, token, id);
    expect(tx.status).toBe("pending_user_transfer_start");
    expect(tx.withdraw_anchor_account).toBe(config.distributionKeypair.publicKey());
    expect(tx.withdraw_memo_type).toBe("text");
    expect(tx.withdraw_memo).toMatch(/^[0-9a-f]{24}$/);

    const pay = await app.inject({ method: "POST", url: `/sandbox/withdrawals/${id}/stellar-payment` });
    expect(pay.statusCode).toBe(200);

    tx = await getTx(app, token, id);
    expect(tx.status).toBe("completed");
    expect(tx.external_transaction_id).toMatch(/^mock_payout_/);
  });

  it("flags a withdrawal where the wrong amount arrives", async () => {
    const { app, token, id } = await startInteractive("withdraw", "50");
    await app.inject({ method: "POST", url: `/sandbox/withdrawals/${id}/stellar-payment`, payload: { amount: "49" } });
    const tx = await getTx(app, token, id);
    expect(tx.status).toBe("error");
    expect(tx.message).toContain("expected 50");
  });

  it("re-renders the form with an error for out-of-range amounts", async () => {
    const { submit } = await startInteractive("deposit", "999999");
    expect(submit.statusCode).toBe(400);
    expect(submit.body).toContain("amount must be between");
  });

  it("does not let another account read a transaction", async () => {
    const { app, id } = await startInteractive("deposit");
    const { token: other } = await authenticate(app);
    const res = await app.inject({
      method: "GET",
      url: `/sep24/transaction?id=${id}`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("escapes user input in the interactive page", async () => {
    const { app, id, interactiveToken } = await startInteractive("deposit", "abc");
    const res = await app.inject({
      method: "POST",
      url: "/sep24/interactive",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        transaction_id: id,
        token: interactiveToken,
        amount: "10",
        name: "<script>alert(1)</script>",
        email: "bad",
      }).toString(),
    });
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;");
  });
});
