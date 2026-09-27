import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { authenticate, testApp } from "./helpers.js";

describe("SEP-1 stellar.toml", () => {
  it("advertises signing key, auth and SEP-24 endpoints with CORS", async () => {
    const { app, config } = await testApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/stellar.toml" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toContain(`SIGNING_KEY = "${config.signingKeypair.publicKey()}"`);
    expect(res.body).toContain(`WEB_AUTH_ENDPOINT = "http://localhost:8080/auth"`);
    expect(res.body).toContain(`TRANSFER_SERVER_SEP0024 = "http://localhost:8080/sep24"`);
    expect(res.body).toContain(`anchor_asset = "USD"`);
  });
});

describe("SEP-10 web auth", () => {
  it("issues a JWT for a correctly signed challenge", async () => {
    const { app } = await testApp();
    const { token } = await authenticate(app);
    expect(token.split(".")).toHaveLength(3);
  });

  it("rejects an invalid account", async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: "GET", url: "/auth?account=nope" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a challenge signed by the wrong key", async () => {
    const { app } = await testApp();
    const client = Keypair.random();
    const { transaction, network_passphrase } = (
      await app.inject({ method: "GET", url: `/auth?account=${client.publicKey()}` })
    ).json();
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(Keypair.random());
    const res = await app.inject({ method: "POST", url: "/auth", payload: { transaction: tx.toXDR() } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a challenge issued by a different server", async () => {
    const { app: a } = await testApp();
    const { app: b } = await testApp();
    const client = Keypair.random();
    const { transaction, network_passphrase } = (
      await a.inject({ method: "GET", url: `/auth?account=${client.publicKey()}` })
    ).json();
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);
    const res = await b.inject({ method: "POST", url: "/auth", payload: { transaction: tx.toXDR() } });
    expect(res.statusCode).toBe(400);
  });
});
