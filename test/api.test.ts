import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, getTx, startTx, submitApi, testApp } from "./helpers.js";

describe("interactive JSON API (/api/interactive/:id)", () => {
  it("returns the transaction, limits, fee and escrow settings", async () => {
    const ctx = await testApp();
    const { id, interactiveToken } = await startTx(ctx, "withdraw");
    const res = await ctx.app.inject({ method: "GET", url: `/api/interactive/${id}?token=${interactiveToken}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.editable).toBe(true);
    expect(body.transaction).toMatchObject({ id, kind: "withdrawal", status: "incomplete" });
    expect(body.limits).toEqual({ min: "1", max: "10000" });
    expect(body.fee).toEqual({ fixed: "0.50", percent: "1" });
    expect(body.escrow).toMatchObject({ enabled: true, contract_id: "SANDBOX_ESCROW", timeout_ledgers: 17280 });
    expect(body.lang).toBe("en");
  });

  it("submits the form and returns deposit instructions", async () => {
    const ctx = await testApp();
    const { id, interactiveToken } = await startTx(ctx, "deposit");
    const res = await submitApi(ctx, id, interactiveToken, { amount: "100" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.editable).toBe(false);
    expect(body.transaction).toMatchObject({
      status: "pending_user_transfer_start",
      amount_fee: "1.50",
      amount_out: "98.50",
    });
    expect(body.deposit_instructions.reference).toMatch(/^ZEPHYR-/);
  });

  it("returns JSON validation errors", async () => {
    const ctx = await testApp();
    const { id, interactiveToken } = await startTx(ctx, "deposit");
    const tooBig = await submitApi(ctx, id, interactiveToken, { amount: "999999" });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error).toMatch(/between/);
    const badEmail = await submitApi(ctx, id, interactiveToken, { amount: "10", email: "nope" });
    expect(badEmail.json().error).toMatch(/email/);
    const missing = await ctx.app.inject({
      method: "POST",
      url: `/api/interactive/${id}`,
      headers: bearer(interactiveToken),
      payload: { amount: "10" },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("requires a valid interactive token scoped to the transaction", async () => {
    const ctx = await testApp();
    const a = await startTx(ctx, "deposit");
    const b = await startTx(ctx, "deposit");
    expect((await ctx.app.inject({ method: "GET", url: `/api/interactive/${a.id}` })).statusCode).toBe(401);
    const crossed = await ctx.app.inject({
      method: "GET",
      url: `/api/interactive/${a.id}`,
      headers: bearer(b.interactiveToken),
    });
    expect(crossed.statusCode).toBe(403);
  });

  it("lets the more_info token read but not submit", async () => {
    const ctx = await testApp();
    const { id, token } = await startTx(ctx, "deposit");
    const moreInfo = new URL((await getTx(ctx, token, id)).more_info_url).searchParams.get("token")!;
    const read = await ctx.app.inject({ method: "GET", url: `/api/interactive/${id}`, headers: bearer(moreInfo) });
    expect(read.statusCode).toBe(200);
    expect(read.json().editable).toBe(false);
    const write = await submitApi(ctx, id, moreInfo, { amount: "10" });
    expect(write.statusCode).toBe(403);
  });

  it("refuses escrow mode when escrow is disabled", async () => {
    const ctx = await testApp({}, { escrow: null });
    const { id, interactiveToken } = await startTx(ctx, "withdraw");
    expect(
      (await ctx.app.inject({ method: "GET", url: `/api/interactive/${id}?token=${interactiveToken}` })).json().escrow,
    ).toEqual({ enabled: false });
    const res = await submitApi(ctx, id, interactiveToken, { amount: "10", withdraw_mode: "escrow" });
    expect(res.statusCode).toBe(400);
  });
});

describe("frontend proxy", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`frontend saw ${req.url}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("serves /sep24/interactive/* and /_next/* from FRONTEND_URL on the anchor domain", async () => {
    const ctx = await testApp({ FRONTEND_URL: url });
    const page = await ctx.app.inject({ method: "GET", url: "/sep24/interactive/deposit?transaction_id=x&token=y" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe("frontend saw /sep24/interactive/deposit?transaction_id=x&token=y");
    const asset = await ctx.app.inject({ method: "GET", url: "/_next/static/chunk.js" });
    expect(asset.body).toBe("frontend saw /_next/static/chunk.js");
  });

  it("does not proxy without FRONTEND_URL", async () => {
    const ctx = await testApp();
    const res = await ctx.app.inject({ method: "GET", url: "/sep24/interactive/deposit" });
    expect(res.statusCode).toBe(404);
  });
});
