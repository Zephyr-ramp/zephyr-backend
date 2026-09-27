import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { isValidAmount } from "./lib/amount.js";

/** Circle's USDC issuer on Stellar testnet. Override with USDC_ISSUER for mainnet. */
export const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Languages the interactive flow is translated into (SEP-24 `lang`). English first. */
export const SUPPORTED_LANGS = ["en"] as const;

const stellarSecret = z.string().refine((s) => {
  try {
    Keypair.fromSecret(s);
    return true;
  } catch {
    return false;
  }
}, "must be a valid Stellar secret key (S...)");

const bool = (def: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(def)
    .transform((v) => v === "true");

const amount = (def: string) => z.string().default(def).refine(isValidAmount, "must be a decimal amount");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Public URL the anchor is reachable at, e.g. https://anchor.example.com */
  BASE_URL: z.url(),
  /** Domain wallets use to discover stellar.toml (no scheme). Defaults to BASE_URL's host. */
  HOME_DOMAIN: z.string().optional(),

  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet"),
  HORIZON_URL: z.url().default("https://horizon-testnet.stellar.org"),
  SOROBAN_RPC_URL: z.url().default("https://soroban-testnet.stellar.org"),

  /** Signs SEP-10 challenges. Must differ from the distribution account. */
  SEP10_SIGNING_SECRET: stellarSecret,
  /** Holds USDC; sends deposits and receives withdrawals. */
  DISTRIBUTION_SECRET: stellarSecret,
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

  /** PostgreSQL connection string. Without it the server uses the non-durable in-memory store. */
  DATABASE_URL: z.string().optional(),

  /** zephyr-frontend origin. When set, /sep24/interactive/* is proxied there. */
  FRONTEND_URL: z.url().optional(),

  USDC_ISSUER: z.string().default(TESTNET_USDC_ISSUER),

  DEPOSIT_MIN: amount("1"),
  DEPOSIT_MAX: amount("10000"),
  WITHDRAW_MIN: amount("1"),
  WITHDRAW_MAX: amount("10000"),
  FEE_FIXED: amount("0.50"),
  FEE_PERCENT: z.coerce.number().min(0).max(100).default(1),

  /** Which fiat payment rail adapter to load. */
  PAYMENT_RAIL: z.enum(["mock", "webhook"]).default("mock"),
  RAIL_API_URL: z.url().optional(),
  RAIL_API_KEY: z.string().optional(),
  /** HMAC secret for POST /webhooks/rail/:provider. Webhooks are disabled without it. */
  RAIL_WEBHOOK_SECRET: z.string().min(16).optional(),

  /** Escrow contract (zephyr-contracts). Enables escrow withdrawals. */
  ESCROW_CONTRACT_ID: z
    .string()
    .refine((c) => StrKey.isValidContract(c), "must be a contract ID (C...)")
    .optional(),
  /** Secret of the escrow's `anchor` address. Defaults to DISTRIBUTION_SECRET. */
  ESCROW_ANCHOR_SECRET: stellarSecret.optional(),
  /** Timeout the wallet should use when locking funds (~1 day at 5 s/ledger). */
  ESCROW_TIMEOUT_LEDGERS: z.coerce.number().int().positive().default(17_280),
  /** Refuse to pay out if the escrow expires within this many ledgers (~10 min). */
  ESCROW_MIN_REMAINING_LEDGERS: z.coerce.number().int().nonnegative().default(120),
  ESCROW_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** First ledger to read escrow events from when no cursor is saved. */
  ESCROW_START_LEDGER: z.coerce.number().int().positive().optional(),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /** Exposes /sandbox endpoints for simulating fiat + on-chain events. Never enable in production. */
  ENABLE_SANDBOX: bool("false"),
  /** Stream Horizon for incoming standard withdrawal payments. */
  ENABLE_WITHDRAWAL_WATCHER: bool("true"),
  /** Poll Soroban RPC for escrow events. */
  ENABLE_ESCROW_WATCHER: bool("true"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const problems: string[] = [];

  const baseUrl = e.BASE_URL.replace(/\/+$/, "");
  const signingKeypair = Keypair.fromSecret(e.SEP10_SIGNING_SECRET);
  const distributionKeypair = Keypair.fromSecret(e.DISTRIBUTION_SECRET);
  const escrowAnchorSecret = e.ESCROW_ANCHOR_SECRET ?? e.DISTRIBUTION_SECRET;

  if (signingKeypair.publicKey() === distributionKeypair.publicKey()) {
    problems.push("SEP10_SIGNING_SECRET must differ from DISTRIBUTION_SECRET");
  }
  if (Keypair.fromSecret(escrowAnchorSecret).publicKey() === signingKeypair.publicKey()) {
    problems.push("ESCROW_ANCHOR_SECRET must differ from SEP10_SIGNING_SECRET");
  }
  if (e.STELLAR_NETWORK === "public" && e.ENABLE_SANDBOX) {
    problems.push("ENABLE_SANDBOX cannot be true on the public network");
  }
  if (e.PAYMENT_RAIL === "webhook" && (!e.RAIL_API_URL || !e.RAIL_API_KEY || !e.RAIL_WEBHOOK_SECRET)) {
    problems.push("PAYMENT_RAIL=webhook requires RAIL_API_URL, RAIL_API_KEY and RAIL_WEBHOOK_SECRET");
  }
  if (e.STELLAR_NETWORK === "public" && !e.DATABASE_URL) {
    problems.push("DATABASE_URL is required on the public network");
  }
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    baseUrl,
    homeDomain: e.HOME_DOMAIN ?? new URL(baseUrl).host,
    network: e.STELLAR_NETWORK,
    networkPassphrase: e.STELLAR_NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET,
    horizonUrl: e.HORIZON_URL,
    sorobanRpcUrl: e.SOROBAN_RPC_URL,
    signingKeypair,
    distributionKeypair,
    jwtSecret: new TextEncoder().encode(e.JWT_SECRET),
    databaseUrl: e.DATABASE_URL,
    frontendUrl: e.FRONTEND_URL?.replace(/\/+$/, ""),
    asset: { code: "USDC", issuer: e.USDC_ISSUER },
    limits: {
      deposit: { min: e.DEPOSIT_MIN, max: e.DEPOSIT_MAX },
      withdraw: { min: e.WITHDRAW_MIN, max: e.WITHDRAW_MAX },
    },
    fee: { fixed: e.FEE_FIXED, percent: e.FEE_PERCENT },
    paymentRail: e.PAYMENT_RAIL,
    rail: { apiUrl: e.RAIL_API_URL, apiKey: e.RAIL_API_KEY, webhookSecret: e.RAIL_WEBHOOK_SECRET },
    escrow: {
      contractId: e.ESCROW_CONTRACT_ID,
      anchorSecret: escrowAnchorSecret,
      timeoutLedgers: e.ESCROW_TIMEOUT_LEDGERS,
      minRemainingLedgers: e.ESCROW_MIN_REMAINING_LEDGERS,
      pollIntervalMs: e.ESCROW_POLL_INTERVAL_MS,
      startLedger: e.ESCROW_START_LEDGER,
    },
    rateLimit: { max: e.RATE_LIMIT_MAX, windowMs: e.RATE_LIMIT_WINDOW_MS },
    enableSandbox: e.ENABLE_SANDBOX,
    enableWithdrawalWatcher: e.ENABLE_WITHDRAWAL_WATCHER,
    enableEscrowWatcher: e.ENABLE_ESCROW_WATCHER,
  };
}
