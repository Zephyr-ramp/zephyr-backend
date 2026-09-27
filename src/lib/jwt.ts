import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import type { Config } from "../config.js";
import { AnchorError } from "./errors.js";

const SEP10_TTL_SECONDS = 24 * 60 * 60;
const INTERACTIVE_TTL_SECONDS = 10 * 60;

export interface AuthContext {
  /** Stellar account (G...) proven via SEP-10. */
  account: string;
  memo?: string | undefined;
  homeDomain?: string | undefined;
  /** SEP-10 client_domain the wallet proved, if any. */
  clientDomain?: string | undefined;
}

export async function issueSep10Token(
  config: Config,
  claims: {
    account: string;
    memo?: string | null;
    challengeHash: string;
    homeDomain: string;
    clientDomain?: string | undefined;
  },
): Promise<string> {
  const sub = claims.memo ? `${claims.account}:${claims.memo}` : claims.account;
  return new SignJWT({
    home_domain: claims.homeDomain,
    ...(claims.clientDomain ? { client_domain: claims.clientDomain } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(`${config.baseUrl}/auth`)
    .setSubject(sub)
    .setJti(claims.challengeHash)
    .setIssuedAt()
    .setExpirationTime(`${SEP10_TTL_SECONDS}s`)
    .sign(config.jwtSecret);
}

export async function verifySep10Token(config: Config, token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: `${config.baseUrl}/auth` });
  if (typeof payload.sub !== "string") throw new Error("missing sub");
  const [account, memo] = payload.sub.split(":");
  return {
    account: account!,
    memo,
    homeDomain: typeof payload.home_domain === "string" ? payload.home_domain : undefined,
    clientDomain: typeof payload.client_domain === "string" ? payload.client_domain : undefined,
  };
}

/** Short-lived token embedded in the interactive URL; scoped to a single transaction. */
export async function issueInteractiveToken(config: Config, transactionId: string, account: string) {
  return new SignJWT({ acct: account })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(`${config.baseUrl}/sep24/interactive`)
    .setSubject(transactionId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${INTERACTIVE_TTL_SECONDS}s`)
    .sign(config.jwtSecret);
}

export async function verifyInteractiveToken(config: Config, token: string, transactionId: string) {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, {
      issuer: `${config.baseUrl}/sep24/interactive`,
      subject: transactionId,
    });
    return { account: String(payload.acct) };
  } catch {
    throw new AnchorError(403, "interactive session expired or invalid");
  }
}

/** Fastify preHandler: requires a valid SEP-10 JWT and attaches `request.auth`. */
export function requireSep10(config: Config) {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new AnchorError(403, "authentication required", { type: "authentication_required" });
    try {
      request.auth = await verifySep10Token(config, token);
    } catch {
      throw new AnchorError(403, "invalid or expired token", { type: "authentication_required" });
    }
  };
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
