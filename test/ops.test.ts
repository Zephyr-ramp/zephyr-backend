import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HttpCallbackNotifier, validateCallbackUrl } from "../src/notify/callbacks.js";
import { InMemoryTransactionStore } from "../src/store/memory.js";
import { testApp, testConfig } from "./helpers.js";

describe("operations", () => {
  it("/health reports liveness", async () => {
    const ctx = await testApp();
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ status: "ok", network: "testnet", rail: "mock" });
  });

  it("/ready is 200 when the store answers and 503 when it doesn't", async () => {
    const ok = await testApp();
    const res = await ok.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { store: "ok", escrow_watcher: "ok" } });

    const store = new InMemoryTransactionStore();
    store.ping = async () => {
      throw new Error("db down");
    };
    const down = await testApp({}, { store });
    const bad = await down.app.inject({ method: "GET", url: "/ready" });
    expect(bad.statusCode).toBe(503);
    expect(bad.json().checks.store).toBe("unavailable");
  });

  it("rate limits /auth and SEP-24 endpoints", async () => {
    const ctx = await testApp({ RATE_LIMIT_MAX: "3" });
    const account = Keypair.random().publicKey();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await ctx.app.inject({ method: "GET", url: `/auth?account=${account}` })).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // Unlimited endpoints are unaffected.
    expect((await ctx.app.inject({ method: "GET", url: "/sep24/info" })).statusCode).toBe(200);
  });

  it("serves openapi.yaml, and every documented path exists", async () => {
    const ctx = await testApp({ RAIL_WEBHOOK_SECRET: "x".repeat(16) });
    const res = await ctx.app.inject({ method: "GET", url: "/openapi.yaml" });
    expect(res.statusCode).toBe(200);
    const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
    expect(spec.openapi).toBe("3.1.0");
    const routes = ctx.app.printRoutes({ commonPrefix: false });
    for (const [path, ops] of Object.entries<Record<string, unknown>>(spec.paths)) {
      const fastifyPath = path.replace(/\{(\w+)\}/g, ":$1");
      for (const method of Object.keys(ops).filter((k) => k !== "parameters")) {
        expect(ctx.app.hasRoute({ method: method.toUpperCase() as "GET", url: fastifyPath }), `${method} ${path}`).toBe(
          true,
        );
      }
    }
    expect(routes).toBeTruthy();
  });

  it("documents exactly the SEP-24 statuses", async () => {
    const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
    const { TRANSACTION_STATUSES } = await import("../src/store/types.js");
    expect(spec.components.schemas.TransactionStatus.enum).toEqual([...TRANSACTION_STATUSES]);
  });

  it("does not register sandbox endpoints unless enabled", async () => {
    const ctx = await testApp({ ENABLE_SANDBOX: "false" });
    const res = await ctx.app.inject({ method: "POST", url: "/sandbox/deposits/x/fiat-received" });
    expect(res.statusCode).toBe(404);
  });
});

describe("config validation", () => {
  it("refuses the sandbox on the public network", () => {
    expect(() => testConfig({ STELLAR_NETWORK: "public", DATABASE_URL: "postgres://x" })).toThrow(/ENABLE_SANDBOX/);
  });

  it("requires a database on the public network", () => {
    expect(() => testConfig({ STELLAR_NETWORK: "public", ENABLE_SANDBOX: "false" })).toThrow(/DATABASE_URL/);
  });

  it("requires different signing and distribution keys", () => {
    const secret = Keypair.random().secret();
    expect(() => testConfig({ SEP10_SIGNING_SECRET: secret, DISTRIBUTION_SECRET: secret })).toThrow(/must differ/);
    expect(() => testConfig({ SEP10_SIGNING_SECRET: secret, ESCROW_ANCHOR_SECRET: secret })).toThrow(
      /ESCROW_ANCHOR_SECRET/,
    );
  });

  it("validates rail, escrow and amount settings", () => {
    expect(() => testConfig({ PAYMENT_RAIL: "webhook" })).toThrow(/RAIL_API_URL/);
    expect(() => testConfig({ ESCROW_CONTRACT_ID: "not-a-contract" })).toThrow(/contract ID/);
    expect(() => testConfig({ FEE_FIXED: "0.1.2" })).toThrow(/FEE_FIXED/);
    expect(() => testConfig({ JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("accepts a full escrow configuration", () => {
    const c = testConfig({ ESCROW_CONTRACT_ID: "CCQCVQTYB45FXJG6BPLR4RPBMBOE4VD73MUMTDWT6Q55TXINSEBV3IOQ" });
    expect(c.escrow.contractId).toMatch(/^C/);
    expect(c.escrow.anchorSecret).toBe(c.distributionKeypair.secret());
  });
});

describe("wallet callbacks", () => {
  it("only accepts https (or localhost on testnet)", () => {
    expect(validateCallbackUrl("https://w.example/cb", "public")).toBeUndefined();
    expect(validateCallbackUrl("http://localhost:3000/cb", "testnet")).toBeUndefined();
    expect(validateCallbackUrl("http://localhost:3000/cb", "public")).toBeDefined();
    expect(validateCallbackUrl("http://w.example/cb", "testnet")).toBeDefined();
    expect(validateCallbackUrl("ftp://w.example", "testnet")).toBeDefined();
    expect(validateCallbackUrl("nope", "testnet")).toBeDefined();
  });

  it("signs the body with the anchor's SIGNING_KEY and retries", async () => {
    const key = Keypair.random();
    const seen: { headers: Record<string, string>; body: string }[] = [];
    let attempts = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      attempts++;
      seen.push({ headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response(null, { status: attempts < 2 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const log = { warn: () => {} };
    const notifier = new HttpCallbackNotifier(key, log, { fetch: fakeFetch, backoffMs: 1 });

    expect(await notifier.deliver("https://wallet.example/cb", { transaction: { id: "t", status: "completed" } })).toBe(
      true,
    );
    expect(attempts).toBe(2);
    const { headers, body } = seen[1]!;
    const match = /^t=(\d+), s=(.+)$/.exec(headers.signature!)!;
    const signed = Buffer.from(`${match[1]}.wallet.example.${body}`);
    expect(key.verify(signed, Buffer.from(match[2]!, "base64"))).toBe(true);
    expect(headers["x-stellar-signature"]).toBe(headers.signature);
  });

  it("gives up after the configured retries", async () => {
    const notifier = new HttpCallbackNotifier(
      Keypair.random(),
      { warn: () => {} },
      {
        retries: 2,
        backoffMs: 1,
        fetch: (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
    );
    expect(await notifier.deliver("https://w.example/cb", { transaction: {} })).toBe(false);
  });
});
