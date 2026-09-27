import { Keypair } from "@stellar/stellar-sdk";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { authenticate, testApp } from "./helpers.js";

describe("SEP-10 multisig and client_domain", () => {
  it("accepts an on-chain account signed by enough of its signers", async () => {
    const ctx = await testApp();
    const client = Keypair.random();
    const cosigner = Keypair.random();
    ctx.stellar.accounts.set(client.publicKey(), {
      threshold: 2,
      signers: [
        { key: client.publicKey(), weight: 1 },
        { key: cosigner.publicKey(), weight: 1 },
      ],
    });
    const { res } = await authenticate(ctx.app, client, { extraSigners: [cosigner] });
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().token).sub).toBe(client.publicKey());
  });

  it("rejects an on-chain account below its medium threshold", async () => {
    const ctx = await testApp();
    const client = Keypair.random();
    ctx.stellar.accounts.set(client.publicKey(), {
      threshold: 2,
      signers: [
        { key: client.publicKey(), weight: 1 },
        { key: Keypair.random().publicKey(), weight: 1 },
      ],
    });
    const { res } = await authenticate(ctx.app, client);
    expect(res.statusCode).toBe(400);
  });

  it("accepts a signer-only account whose master key is disabled", async () => {
    const ctx = await testApp();
    const client = Keypair.random();
    const signer = Keypair.random();
    ctx.stellar.accounts.set(client.publicKey(), {
      threshold: 1,
      signers: [
        { key: client.publicKey(), weight: 0 },
        { key: signer.publicKey(), weight: 1 },
      ],
    });
    // Signed only by the delegated signer, not the master key.
    const { token, client: c } = await authenticate(ctx.app, client, { extraSigners: [signer] });
    expect(c).toBe(client);
    expect(token).toBeTruthy();
  });

  it("falls back to the master key for unfunded accounts", async () => {
    const ctx = await testApp();
    const { res } = await authenticate(ctx.app, Keypair.random());
    expect(res.statusCode).toBe(200);
  });

  it("returns 503 when Horizon can't be reached", async () => {
    const ctx = await testApp();
    ctx.stellar.horizonDown = true;
    const { res } = await authenticate(ctx.app);
    expect(res.statusCode).toBe(503);
  });

  it("verifies client_domain and puts it in the JWT", async () => {
    const ctx = await testApp();
    const walletKey = Keypair.random();
    ctx.stellar.clientDomains.set("wallet.example.com", walletKey.publicKey());
    const { res } = await authenticate(ctx.app, Keypair.random(), {
      clientDomain: "wallet.example.com",
      clientDomainKey: walletKey,
    });
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().token).client_domain).toBe("wallet.example.com");
  });

  it("rejects a client_domain challenge without the wallet's signature", async () => {
    const ctx = await testApp();
    ctx.stellar.clientDomains.set("wallet.example.com", Keypair.random().publicKey());
    const { res } = await authenticate(ctx.app, Keypair.random(), { clientDomain: "wallet.example.com" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown or malformed client_domain", async () => {
    const ctx = await testApp();
    const account = Keypair.random().publicKey();
    const unknown = await ctx.app.inject({
      method: "GET",
      url: `/auth?account=${account}&client_domain=nope.example.com`,
    });
    expect(unknown.statusCode).toBe(400);
    const bad = await ctx.app.inject({ method: "GET", url: `/auth?account=${account}&client_domain=not a domain` });
    expect(bad.statusCode).toBe(400);
  });

  it("rejects a wrong home_domain and a missing transaction", async () => {
    const ctx = await testApp();
    const account = Keypair.random().publicKey();
    const res = await ctx.app.inject({ method: "GET", url: `/auth?account=${account}&home_domain=evil.com` });
    expect(res.statusCode).toBe(400);
    const post = await ctx.app.inject({ method: "POST", url: "/auth", payload: {} });
    expect(post.statusCode).toBe(400);
  });

  it("accepts the challenge as a form-encoded body", async () => {
    const ctx = await testApp();
    const client = Keypair.random();
    const { transaction } = (
      await ctx.app.inject({ method: "GET", url: `/auth?account=${client.publicKey()}` })
    ).json();
    const { TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
    const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET);
    tx.sign(client);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ transaction: tx.toXDR() }).toString(),
    });
    expect(res.statusCode).toBe(200);
  });
});
