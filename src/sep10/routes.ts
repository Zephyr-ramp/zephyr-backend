import { type Horizon, StrKey, TransactionBuilder, WebAuth, type Transaction } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { AnchorError } from "../lib/errors.js";
import { issueSep10Token } from "../lib/jwt.js";
import type { StellarGateway } from "../stellar/gateway.js";

const CHALLENGE_TIMEOUT_SECONDS = 300;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}(:\d{1,5})?$/i;

const ChallengeQuery = z.object({
  account: z.string().refine((a) => StrKey.isValidEd25519PublicKey(a), "invalid account"),
  memo: z
    .string()
    .regex(/^\d{1,20}$/, "memo must be a numeric ID memo")
    .optional(),
  home_domain: z.string().optional(),
  client_domain: z.string().regex(DOMAIN_RE, "invalid client_domain").optional(),
});

/**
 * SEP-10: Stellar Web Authentication.
 * GET returns a challenge transaction; POST verifies the client's signatures and issues a JWT.
 *
 * - Accounts that exist on chain are verified against their current signers and
 *   medium threshold (`verifyChallengeTxThreshold`), so multisig accounts work.
 * - Accounts that don't exist yet are verified against their master key.
 * - With `client_domain`, the challenge also has to be signed by the SIGNING_KEY
 *   published in that domain's stellar.toml, and the JWT carries `client_domain`.
 */
export async function sep10Routes(
  app: FastifyInstance,
  { config, stellar, rateLimit }: { config: Config; stellar: StellarGateway; rateLimit: object },
) {
  const webAuthDomain = new URL(config.baseUrl).host;
  const serverAccount = config.signingKeypair.publicKey();

  app.get("/auth", { config: { rateLimit } }, async (request) => {
    const parsed = ChallengeQuery.safeParse(request.query);
    if (!parsed.success) throw new AnchorError(400, parsed.error.issues[0]?.message ?? "invalid request");
    const { account, memo, home_domain, client_domain } = parsed.data;
    if (home_domain && home_domain !== config.homeDomain) {
      throw new AnchorError(400, `home_domain must be ${config.homeDomain}`);
    }

    let clientSigningKey: string | null = null;
    if (client_domain) {
      try {
        clientSigningKey = await stellar.fetchClientDomainSigningKey(client_domain);
      } catch (err) {
        request.log.info({ err, client_domain }, "client_domain lookup failed");
        throw new AnchorError(400, `could not read SIGNING_KEY from ${client_domain}/.well-known/stellar.toml`);
      }
    }

    const transaction = WebAuth.buildChallengeTx(
      config.signingKeypair,
      account,
      config.homeDomain,
      CHALLENGE_TIMEOUT_SECONDS,
      config.networkPassphrase,
      webAuthDomain,
      memo ?? null,
      client_domain ?? null,
      clientSigningKey,
    );
    return { transaction, network_passphrase: config.networkPassphrase };
  });

  app.post("/auth", { config: { rateLimit } }, async (request) => {
    const body = (request.body ?? {}) as { transaction?: unknown };
    if (typeof body.transaction !== "string") throw new AnchorError(400, "transaction is required");
    const challenge = body.transaction;

    let read: ReturnType<typeof WebAuth.readChallengeTx>;
    try {
      read = WebAuth.readChallengeTx(
        challenge,
        serverAccount,
        config.networkPassphrase,
        config.homeDomain,
        webAuthDomain,
      );
    } catch (err) {
      throw new AnchorError(400, err instanceof Error ? err.message : "invalid challenge");
    }
    const { clientAccountID, memo, matchedHomeDomain, tx } = read;

    let signers: Awaited<ReturnType<StellarGateway["loadAccountSigners"]>>;
    try {
      signers = await stellar.loadAccountSigners(clientAccountID);
    } catch (err) {
      request.log.error({ err }, "could not load account signers from Horizon");
      throw new AnchorError(503, "unable to verify account signers; try again");
    }

    try {
      if (signers) {
        const summary: Horizon.ServerApi.AccountRecordSigners[] = signers.signers.map((s) => ({
          key: s.key,
          weight: s.weight,
          type: "ed25519_public_key",
        }));
        WebAuth.verifyChallengeTxThreshold(
          challenge,
          serverAccount,
          config.networkPassphrase,
          signers.threshold,
          summary,
          config.homeDomain,
          webAuthDomain,
        );
      } else {
        // Unfunded account: only its master key can sign.
        WebAuth.verifyChallengeTxSigners(
          challenge,
          serverAccount,
          config.networkPassphrase,
          [clientAccountID],
          config.homeDomain,
          webAuthDomain,
        );
      }
    } catch (err) {
      request.log.info({ err }, "SEP-10 challenge rejected");
      throw new AnchorError(400, err instanceof Error ? err.message : "invalid challenge");
    }

    const hash = Buffer.from(TransactionBuilder.fromXDR(challenge, config.networkPassphrase).hash()).toString("hex");
    const token = await issueSep10Token(config, {
      account: clientAccountID,
      memo,
      challengeHash: hash,
      homeDomain: matchedHomeDomain,
      clientDomain: readClientDomain(tx),
    });
    return { token };
  });
}

/** The value of the challenge's `client_domain` ManageData op, if any. */
function readClientDomain(tx: Transaction): string | undefined {
  for (const op of tx.operations) {
    if (op.type === "manageData" && op.name === "client_domain" && op.value) {
      return Buffer.from(op.value).toString("utf8");
    }
  }
  return undefined;
}
