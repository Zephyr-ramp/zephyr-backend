import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { type AppDeps, buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CallbackNotifier } from "../src/notify/callbacks.js";
import type { PaymentRail } from "../src/rails/types.js";
import type { AccountSigners, IncomingPayment, StellarGateway } from "../src/stellar/gateway.js";

export class FakeStellarGateway implements StellarGateway {
  sent: { destination: string; amount: string; memo?: string | undefined }[] = [];
  fail = false;
  /** On-chain accounts (absent = unfunded). */
  accounts = new Map<string, AccountSigners>();
  /** client_domain -> SIGNING_KEY published in its stellar.toml. */
  clientDomains = new Map<string, string>();
  horizonDown = false;

  async sendPayment(input: { destination: string; amount: string; memo?: string | undefined }) {
    if (this.fail) throw new Error("horizon down");
    this.sent.push(input);
    return `fakehash${this.sent.length}`;
  }
  watchIncomingPayments(_cb: (p: IncomingPayment) => void) {
    return () => {};
  }
  async loadAccountSigners(account: string) {
    if (this.horizonDown) throw new Error("horizon down");
    return this.accounts.get(account);
  }
  async fetchClientDomainSigningKey(domain: string) {
    const key = this.clientDomains.get(domain);
    if (!key) throw new Error(`no stellar.toml for ${domain}`);
    return key;
  }
}

export class RecordingNotifier implements CallbackNotifier {
  calls: { url: string; body: { transaction: { status: string } & Record<string, unknown> } }[] = [];
  notify(url: string, body: { transaction: unknown }) {
    this.calls.push({ url, body: body as RecordingNotifier["calls"][number]["body"] });
  }
}

/** A rail whose payout outcome the test controls. */
export class ControllableRail implements PaymentRail {
  readonly name: string;
  payoutMode: "completed" | "pending" | "throw" = "completed";
  payouts: string[] = [];
  constructor(name = "mock") {
    this.name = name;
  }
  async createDepositInstructions(input: { transactionId: string; amount: string }) {
    return {
      externalId: `dep_${input.transactionId}`,
      instructions: { reference: input.transactionId, amount: input.amount },
    };
  }
  async sendPayout(input: { transactionId: string }) {
    if (this.payoutMode === "throw") throw new Error("bank said no");
    this.payouts.push(input.transactionId);
    return { externalId: `payout_${input.transactionId}`, status: this.payoutMode };
  }
}

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    BASE_URL: "http://localhost:8080",
    SEP10_SIGNING_SECRET: Keypair.random().secret(),
    DISTRIBUTION_SECRET: Keypair.random().secret(),
    JWT_SECRET: "x".repeat(32),
    LOG_LEVEL: "silent",
    ENABLE_SANDBOX: "true",
    ...overrides,
  });
}

export async function testApp(overrides: Record<string, string> = {}, deps: AppDeps = {}) {
  const config = testConfig(overrides);
  const stellar = new FakeStellarGateway();
  const notifier = new RecordingNotifier();
  const built = await buildApp(config, { stellar, notifier, ...deps });
  return { ...built, config, stellar: (deps.stellar as FakeStellarGateway | undefined) ?? stellar, notifier };
}

export type TestApp = Awaited<ReturnType<typeof testApp>>;

/** Runs the full SEP-10 flow for a keypair and returns its JWT. */
export async function authenticate(
  app: TestApp["app"],
  client = Keypair.random(),
  opts: { extraSigners?: Keypair[]; clientDomain?: string; clientDomainKey?: Keypair } = {},
) {
  const params = new URLSearchParams({ account: client.publicKey() });
  if (opts.clientDomain) params.set("client_domain", opts.clientDomain);
  const challengeRes = await app.inject({ method: "GET", url: `/auth?${params.toString()}` });
  const { transaction, network_passphrase } = challengeRes.json();
  const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
  tx.sign(client, ...(opts.extraSigners ?? []));
  if (opts.clientDomainKey) tx.sign(opts.clientDomainKey);
  const tokenRes = await app.inject({ method: "POST", url: "/auth", payload: { transaction: tx.toXDR() } });
  return { token: tokenRes.json().token as string, client, res: tokenRes };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Starts an interactive transaction and returns its id + interactive token. */
export async function startTx(
  ctx: TestApp,
  kind: "deposit" | "withdraw",
  body: Record<string, string> = {},
  client?: Keypair,
) {
  const { token, client: c } = await authenticate(ctx.app, client);
  const res = await ctx.app.inject({
    method: "POST",
    url: `/sep24/transactions/${kind}/interactive`,
    headers: bearer(token),
    payload: { asset_code: "USDC", ...body },
  });
  if (res.statusCode !== 200) throw new Error(`start failed: ${res.body}`);
  const { id, url } = res.json() as { id: string; url: string };
  return { id, url: new URL(url), interactiveToken: new URL(url).searchParams.get("token")!, token, client: c };
}

/** Submits the interactive form through the JSON API. */
export async function submitApi(
  ctx: TestApp,
  id: string,
  interactiveToken: string,
  form: { amount: string; name?: string; email?: string; withdraw_mode?: "standard" | "escrow" },
) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/interactive/${id}`,
    headers: bearer(interactiveToken),
    payload: { name: "Ada Lovelace", email: "ada@example.com", ...form },
  });
}

export async function getTx(ctx: TestApp, token: string, id: string) {
  const res = await ctx.app.inject({ method: "GET", url: `/sep24/transaction?id=${id}`, headers: bearer(token) });
  return res.json().transaction;
}
