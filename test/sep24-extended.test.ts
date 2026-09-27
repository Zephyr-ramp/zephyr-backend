import { describe, expect, it } from "vitest";
import { pickLang } from "../src/sep24/routes.js";
import { authenticate, bearer, getTx, startTx, submitApi, testApp } from "./helpers.js";

describe("SEP-24 completeness", () => {
  it("advertises fees and limits in /info", async () => {
    const ctx = await testApp({ FEE_FIXED: "0.25", FEE_PERCENT: "0.3" });
    const info = (await ctx.app.inject({ method: "GET", url: "/sep24/info" })).json();
    expect(info.deposit.USDC).toMatchObject({
      enabled: true,
      min_amount: 1,
      max_amount: 10000,
      fee_fixed: 0.25,
      fee_percent: 0.3,
    });
    expect(info.withdraw.USDC.fee_percent).toBe(0.3);
  });

  it("returns a more_info_url that opens a status page without SEP-10", async () => {
    const ctx = await testApp();
    const { id, token, interactiveToken } = await startTx(ctx, "deposit");
    await submitApi(ctx, id, interactiveToken, { amount: "20" });
    const tx = await getTx(ctx, token, id);
    const url = new URL(tx.more_info_url);
    expect(url.pathname).toBe("/sep24/transaction/more_info");

    const page = await ctx.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("pending_user_transfer_start");

    const forged = await ctx.app.inject({ method: "GET", url: `${url.pathname}?id=${id}&token=forged` });
    expect(forged.statusCode).toBe(403);
  });

  it("redirects more_info to the frontend when FRONTEND_URL is set", async () => {
    const ctx = await testApp({ FRONTEND_URL: "http://127.0.0.1:1" });
    const { id, token } = await startTx(ctx, "deposit");
    const url = new URL((await getTx(ctx, token, id)).more_info_url);
    const res = await ctx.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/sep24\/interactive\/more-info\?transaction_id=/);
  });

  it("points the interactive URL at the frontend pages when FRONTEND_URL is set", async () => {
    const ctx = await testApp({ FRONTEND_URL: "http://127.0.0.1:1" });
    const { url } = await startTx(ctx, "withdraw", { withdraw_mode: "escrow", lang: "en-US" });
    expect(url.pathname).toBe("/sep24/interactive/withdraw");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("withdraw_mode")).toBe("escrow");
  });

  it("POSTs the transaction to on_change_callback on every status change", async () => {
    const ctx = await testApp();
    const { id, interactiveToken } = await startTx(ctx, "deposit", { on_change_callback: "https://wallet.example/cb" });
    await submitApi(ctx, id, interactiveToken, { amount: "20" });
    await ctx.app.inject({ method: "POST", url: `/sandbox/deposits/${id}/fiat-received` });
    expect(ctx.notifier.calls.every((c) => c.url === "https://wallet.example/cb")).toBe(true);
    expect(ctx.notifier.calls.map((c) => c.body.transaction.status)).toEqual([
      "pending_user_transfer_start",
      "pending_anchor",
      "pending_stellar",
      "completed",
    ]);
  });

  it("rejects a non-https on_change_callback", async () => {
    const ctx = await testApp();
    const { token } = await authenticate(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/sep24/transactions/deposit/interactive",
      headers: bearer(token),
      payload: { asset_code: "USDC", on_change_callback: "http://wallet.example/cb" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts multipart/form-data request bodies", async () => {
    const ctx = await testApp();
    const { token } = await authenticate(ctx.app);
    const boundary = "zephyrboundary";
    const part = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/sep24/transactions/deposit/interactive",
      headers: { ...bearer(token), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `${part("asset_code", "USDC")}${part("amount", "12")}${part("lang", "fr")}--${boundary}--\r\n`,
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(new URL(url).searchParams.get("lang")).toBe("en"); // unsupported -> English
  });

  it("narrows lang to supported languages", () => {
    expect(pickLang("en-GB")).toBe("en");
    expect(pickLang("EN")).toBe("en");
    expect(pickLang("es")).toBe("en");
    expect(pickLang(undefined)).toBe("en");
  });

  it("pages /transactions with paging_id and filters by kind", async () => {
    const ctx = await testApp();
    const { token, client } = await authenticate(ctx.app);
    const ids: string[] = [];
    for (const kind of ["deposit", "withdraw", "deposit"]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/sep24/transactions/${kind}/interactive`,
        headers: bearer(token),
        payload: { asset_code: "USDC" },
      });
      ids.push(res.json().id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = async (q: string) =>
      (await ctx.app.inject({ method: "GET", url: `/sep24/transactions?asset_code=USDC${q}`, headers: bearer(token) }))
        .json()
        .transactions.map((t: { id: string }) => t.id);
    expect(await list("")).toEqual([...ids].reverse());
    expect(await list(`&paging_id=${ids[2]}`)).toEqual([ids[1], ids[0]]);
    expect(await list("&kind=withdrawal")).toEqual([ids[1]]);
    expect(await list("&limit=1")).toEqual([ids[2]]);
    expect(client).toBeTruthy();
  });

  it("rejects bad list queries and a missing id", async () => {
    const ctx = await testApp();
    const { token } = await authenticate(ctx.app);
    expect(
      (await ctx.app.inject({ method: "GET", url: "/sep24/transactions", headers: bearer(token) })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.app.inject({ method: "GET", url: "/sep24/transaction", headers: bearer(token) })).statusCode,
    ).toBe(400);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/sep24/transactions/deposit/interactive",
      headers: bearer(token),
      payload: { asset_code: "USDC", asset_issuer: "GWRONG" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves the legacy interactive form and status pages", async () => {
    const ctx = await testApp();
    const { id, interactiveToken } = await startTx(ctx, "withdraw");
    const form = await ctx.app.inject({
      method: "GET",
      url: `/sep24/interactive?transaction_id=${id}&token=${interactiveToken}&withdraw_mode=escrow`,
    });
    expect(form.body).toContain('name="withdraw_mode" value="escrow" checked');
    const bad = await ctx.app.inject({ method: "GET", url: `/sep24/interactive?transaction_id=${id}&token=nope` });
    expect(bad.statusCode).toBe(403);
    const missing = await ctx.app.inject({ method: "GET", url: `/sep24/interactive` });
    expect(missing.statusCode).toBe(400);
  });
});
