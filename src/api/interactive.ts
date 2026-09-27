import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { AnchorError } from "../lib/errors.js";
import { verifyInteractiveToken } from "../lib/jwt.js";
import { verifyMoreInfoToken } from "../lib/signatures.js";
import { toSep24 } from "../sep24/serialize.js";
import type { TransferService } from "../sep24/service.js";
import type { Transaction } from "../store/types.js";

const SubmitBody = z.object({
  amount: z.string(),
  name: z.string(),
  email: z.string(),
  withdraw_mode: z.enum(["standard", "escrow"]).optional(),
});

/**
 * JSON API behind zephyr-frontend's interactive pages (see openapi.yaml).
 *
 * Auth: the short-lived interactive token from the SEP-24 interactive URL, as
 * `Authorization: Bearer <token>` or `?token=`. GET also accepts the read-only
 * `more_info_url` token.
 */
export async function interactiveApiRoutes(
  app: FastifyInstance,
  { config, service, rateLimit }: { config: Config; service: TransferService; rateLimit: object },
) {
  const view = (tx: Transaction, readOnly: boolean) => ({
    transaction: toSep24(tx, config),
    editable: !readOnly && tx.status === "incomplete",
    lang: tx.lang ?? "en",
    asset: { code: config.asset.code, issuer: config.asset.issuer },
    limits: tx.kind === "deposit" ? config.limits.deposit : config.limits.withdraw,
    // Strings, so the frontend can use exact decimal math. Same formula as the server.
    fee: { fixed: config.fee.fixed, percent: String(config.fee.percent) },
    deposit_instructions: tx.depositInstructions ?? null,
    escrow: service.escrowEnabled
      ? {
          enabled: true,
          contract_id: tx.escrow?.contractId ?? service.escrowContractId ?? null,
          timeout_ledgers: config.escrow.timeoutLedgers,
          network_passphrase: config.networkPassphrase,
          soroban_rpc_url: config.sorobanRpcUrl,
        }
      : { enabled: false },
  });

  async function authorize(request: FastifyRequest, id: string, allowReadOnly: boolean) {
    const header = request.headers.authorization;
    const token =
      (header?.startsWith("Bearer ") ? header.slice(7) : undefined) ?? (request.query as { token?: string }).token;
    if (!token) throw new AnchorError(401, "missing interactive token");

    if (allowReadOnly && verifyMoreInfoToken(config.jwtSecret, id, token)) {
      return { tx: await service.mustGet(id), readOnly: true };
    }
    const { account } = await verifyInteractiveToken(config, token, id);
    return { tx: await service.getForAccount(id, account), readOnly: false };
  }

  app.get("/api/interactive/:id", { config: { rateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const { tx, readOnly } = await authorize(request, id, true);
    return view(tx, readOnly);
  });

  app.post("/api/interactive/:id", { config: { rateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await authorize(request, id, false);
    const parsed = SubmitBody.safeParse(request.body ?? {});
    if (!parsed.success) throw new AnchorError(400, parsed.error.issues[0]?.message ?? "invalid request");
    const b = parsed.data;
    const tx = await service.submitInteractive(id, {
      amount: b.amount,
      name: b.name,
      email: b.email,
      withdrawMode: b.withdraw_mode,
    });
    return view(tx, false);
  });
}
