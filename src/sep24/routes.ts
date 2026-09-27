import { StrKey } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Config, SUPPORTED_LANGS } from "../config.js";
import { AnchorError } from "../lib/errors.js";
import { issueInteractiveToken, requireSep10, verifyInteractiveToken } from "../lib/jwt.js";
import { verifyMoreInfoToken } from "../lib/signatures.js";
import { validateCallbackUrl } from "../notify/callbacks.js";
import type { TransactionStore } from "../store/types.js";
import { renderForm, renderStatus } from "./pages.js";
import { toSep24 } from "./serialize.js";
import type { TransferService } from "./service.js";

const InteractiveBody = z.object({
  asset_code: z.string(),
  asset_issuer: z.string().optional(),
  amount: z.string().optional(),
  account: z
    .string()
    .refine((a) => StrKey.isValidEd25519PublicKey(a) || StrKey.isValidMed25519PublicKey(a), "invalid account")
    .optional(),
  lang: z.string().optional(),
  on_change_callback: z.string().optional(),
  // Zephyr extension: preselect escrow mode in the interactive form.
  withdraw_mode: z.enum(["standard", "escrow"]).optional(),
});

const ListQuery = z.object({
  asset_code: z.string(),
  kind: z.enum(["deposit", "withdrawal"]).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  no_older_than: z.iso.datetime().optional(),
  paging_id: z.string().optional(),
  lang: z.string().optional(),
});

/** Narrow an RFC 4646 tag to a supported language; unsupported tags fall back to English (SEP-24). */
export function pickLang(lang: string | undefined): (typeof SUPPORTED_LANGS)[number] {
  const base = lang?.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LANGS as readonly string[]).includes(base ?? "")
    ? (base as (typeof SUPPORTED_LANGS)[number])
    : "en";
}

/** Multipart bodies arrive as `{ field: value }` (attachFieldsToBody: "keyValues"); keep strings only. */
function formFields(body: unknown): Record<string, string | undefined> {
  if (!body || typeof body !== "object") return {};
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

/** SEP-24: Hosted (interactive) deposit and withdrawal. Mounted under /sep24. */
export async function sep24Routes(
  app: FastifyInstance,
  {
    config,
    service,
    store,
    rateLimit,
  }: { config: Config; service: TransferService; store: TransactionStore; rateLimit: object },
) {
  const auth = requireSep10(config);
  const feeNumber = (s: string) => Number(s); // SEP-24 /info uses JSON numbers; display only.
  const assetInfo = (limits: { min: string; max: string }) => ({
    [config.asset.code]: {
      enabled: true,
      min_amount: Number(limits.min),
      max_amount: Number(limits.max),
      fee_fixed: feeNumber(config.fee.fixed),
      fee_percent: config.fee.percent,
    },
  });

  app.get("/info", async () => ({
    deposit: assetInfo(config.limits.deposit),
    withdraw: assetInfo(config.limits.withdraw),
    fee: { enabled: false, description: `${config.fee.fixed} USD + ${config.fee.percent}%` },
    features: { account_creation: false, claimable_balances: false },
  }));

  for (const kind of ["deposit", "withdrawal"] as const) {
    const path = kind === "deposit" ? "/transactions/deposit/interactive" : "/transactions/withdraw/interactive";
    app.post(path, { preHandler: auth, config: { rateLimit } }, async (request) => {
      const parsed = InteractiveBody.safeParse(formFields(request.body));
      if (!parsed.success) throw new AnchorError(400, parsed.error.issues[0]?.message ?? "invalid request");
      const body = parsed.data;
      if (body.asset_issuer && body.asset_issuer !== config.asset.issuer) {
        throw new AnchorError(400, "unsupported asset_issuer");
      }
      if (body.on_change_callback) {
        const problem = validateCallbackUrl(body.on_change_callback, config.network);
        if (problem) throw new AnchorError(400, problem);
      }
      const lang = pickLang(body.lang);

      const tx = await service.start({
        kind,
        account: request.auth!.account,
        accountMemo: request.auth!.memo,
        clientDomain: request.auth!.clientDomain,
        assetCode: body.asset_code,
        amount: body.amount,
        stellarAccount: body.account,
        lang,
        onChangeCallback: body.on_change_callback,
      });
      const token = await issueInteractiveToken(config, tx.id, tx.account);
      const url = config.frontendUrl
        ? new URL(`${config.baseUrl}/sep24/interactive/${kind === "deposit" ? "deposit" : "withdraw"}`)
        : new URL(`${config.baseUrl}/sep24/interactive`);
      url.searchParams.set("transaction_id", tx.id);
      url.searchParams.set("token", token);
      url.searchParams.set("lang", lang);
      if (kind === "withdrawal" && body.withdraw_mode === "escrow") url.searchParams.set("withdraw_mode", "escrow");
      return { type: "interactive_customer_info_needed", url: url.toString(), id: tx.id };
    });
  }

  app.get("/transaction", { preHandler: auth }, async (request) => {
    const q = request.query as { id?: string };
    if (!q.id) throw new AnchorError(400, "id is required");
    const tx = await service.getForAccount(q.id, request.auth!.account);
    return { transaction: toSep24(tx, config) };
  });

  app.get("/transactions", { preHandler: auth }, async (request) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) throw new AnchorError(400, parsed.error.issues[0]?.message ?? "invalid request");
    const q = parsed.data;
    const txs = await store.list({
      account: request.auth!.account,
      assetCode: q.asset_code,
      kind: q.kind,
      limit: q.limit,
      noOlderThan: q.no_older_than ? new Date(q.no_older_than) : undefined,
      pagingId: q.paging_id,
    });
    return { transactions: txs.map((tx) => toSep24(tx, config)) };
  });

  // `more_info_url`: a status page for the transaction, openable without SEP-10.
  app.get("/transaction/more_info", async (request, reply) => {
    const q = request.query as { id?: string; token?: string };
    if (!q.id || !q.token || !verifyMoreInfoToken(config.jwtSecret, q.id, q.token)) {
      throw new AnchorError(403, "invalid more_info link");
    }
    const tx = await service.mustGet(q.id);
    if (config.frontendUrl) {
      const target = new URLSearchParams({ transaction_id: tx.id, token: q.token, lang: tx.lang ?? "en" });
      return reply.redirect(`/sep24/interactive/more-info?${target.toString()}`);
    }
    return reply.type("text/html; charset=utf-8").send(renderStatus(tx));
  });

  // ---- Server-rendered interactive flow. Used when FRONTEND_URL is not set. ----

  app.get("/interactive", async (request, reply) => {
    const q = request.query as { transaction_id?: string; token?: string; withdraw_mode?: string };
    if (!q.transaction_id || !q.token) throw new AnchorError(400, "missing transaction_id or token");
    const { account } = await verifyInteractiveToken(config, q.token, q.transaction_id);
    const tx = await service.getForAccount(q.transaction_id, account);
    const html =
      tx.status === "incomplete"
        ? renderForm(tx, q.token, config, {
            escrowEnabled: service.escrowEnabled,
            values: { withdraw_mode: q.withdraw_mode },
          })
        : renderStatus(tx);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/interactive", { config: { rateLimit } }, async (request, reply) => {
    const b = formFields(request.body);
    if (!b.transaction_id || !b.token) throw new AnchorError(400, "missing transaction_id or token");
    const { account } = await verifyInteractiveToken(config, b.token, b.transaction_id);
    await service.getForAccount(b.transaction_id, account);
    try {
      const tx = await service.submitInteractive(b.transaction_id, {
        amount: b.amount ?? "",
        name: b.name ?? "",
        email: b.email ?? "",
        withdrawMode: b.withdraw_mode === "escrow" ? "escrow" : undefined,
      });
      return reply.type("text/html; charset=utf-8").send(renderStatus(tx));
    } catch (err) {
      if (!(err instanceof AnchorError) || err.statusCode !== 400) throw err;
      const tx = await service.getForAccount(b.transaction_id, account);
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(renderForm(tx, b.token, config, { error: err.message, values: b, escrowEnabled: service.escrowEnabled }));
    }
  });
}
