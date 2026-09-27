import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";

/** SEP-1: stellar.toml, the discovery document wallets read first. */
export function renderStellarToml(config: Config): string {
  const lines = [
    `VERSION = "2.7.0"`,
    `NETWORK_PASSPHRASE = "${config.networkPassphrase}"`,
    `SIGNING_KEY = "${config.signingKeypair.publicKey()}"`,
    `WEB_AUTH_ENDPOINT = "${config.baseUrl}/auth"`,
    `TRANSFER_SERVER_SEP0024 = "${config.baseUrl}/sep24"`,
    `ACCOUNTS = ["${config.distributionKeypair.publicKey()}"]`,
    ``,
    `[DOCUMENTATION]`,
    `ORG_NAME = "Zephyr"`,
    `ORG_URL = "${config.baseUrl}"`,
    `ORG_DESCRIPTION = "Open-source USD <-> USDC on/off-ramp on Stellar"`,
    ``,
    `[[CURRENCIES]]`,
    `code = "${config.asset.code}"`,
    `issuer = "${config.asset.issuer}"`,
    `status = "${config.network === "public" ? "live" : "test"}"`,
    `is_asset_anchored = true`,
    `anchor_asset_type = "fiat"`,
    `anchor_asset = "USD"`,
    `desc = "USD on/off-ramp via ${config.asset.code}"`,
    ``,
  ];
  return lines.join("\n");
}

export async function sep1Routes(app: FastifyInstance, { config }: { config: Config }) {
  const body = renderStellarToml(config);
  app.get("/.well-known/stellar.toml", async (_req, reply) => {
    return reply.type("text/plain; charset=utf-8").send(body);
  });
}
