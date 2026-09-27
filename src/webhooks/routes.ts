import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AnchorError } from "../lib/errors.js";
import { verifyWebhookSignature } from "../lib/signatures.js";
import type { PaymentRail, RailEvent } from "../rails/types.js";
import type { TransferService } from "../sep24/service.js";
import type { TransactionStore } from "../store/types.js";

const EventSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("deposit.received"),
    data: z.object({ transaction_id: z.string(), amount: z.string(), external_id: z.string().optional() }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("payout.completed"),
    data: z.object({ transaction_id: z.string(), external_id: z.string().optional() }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("payout.failed"),
    data: z.object({ transaction_id: z.string(), reason: z.string().optional() }),
  }),
]);

/**
 * `POST /webhooks/rail/:provider`: asynchronous updates from the payment rail.
 *
 * - Authenticity: `Zephyr-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`,
 *   with a 5 minute tolerance against replays.
 * - Idempotency: each event `id` (or the `Idempotency-Key` header) is processed
 *   at most once. Duplicates get `200 { duplicate: true }`.
 *
 * See docs/payment-rails.md for the full contract.
 */
export async function webhookRoutes(
  app: FastifyInstance,
  {
    secret,
    rail,
    service,
    store,
  }: { secret: string; rail: PaymentRail; service: TransferService; store: TransactionStore },
) {
  // Keep the raw bytes: the signature is over the exact body we received.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/rail/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (provider !== rail.name) throw new AnchorError(404, `unknown rail provider: ${provider}`);
    if (!Buffer.isBuffer(request.body)) throw new AnchorError(415, "expected application/json");

    const verified = verifyWebhookSignature(secret, request.body, header(request.headers["zephyr-signature"]));
    if (!verified.ok) throw new AnchorError(401, verified.reason);

    let event: RailEvent;
    try {
      const parsed = EventSchema.safeParse(JSON.parse(request.body.toString("utf8")));
      if (!parsed.success) throw new AnchorError(400, parsed.error.issues[0]?.message ?? "invalid event");
      event = parsed.data;
    } catch (err) {
      if (err instanceof AnchorError) throw err;
      throw new AnchorError(400, "body is not valid JSON");
    }

    const eventId = header(request.headers["idempotency-key"]) ?? event.id;
    if (!(await store.recordWebhookEvent(provider, eventId))) {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    const audit = { actor: `rail:${provider}`, note: `webhook ${event.type} ${eventId}` };
    const id = event.data.transaction_id;
    try {
      switch (event.type) {
        case "deposit.received":
          await service.handleFiatReceived(id, { amount: event.data.amount, audit });
          break;
        case "payout.completed":
          await service.handlePayoutResult(id, { ok: true, externalId: event.data.external_id }, audit);
          break;
        case "payout.failed":
          await service.handlePayoutResult(id, { ok: false, reason: event.data.reason }, audit);
          break;
      }
    } catch (err) {
      // 4xx (unknown transaction, wrong state): final, a retry won't help. Anything
      // else: forget the delivery so the provider's retry gets processed.
      if (!(err instanceof AnchorError) || err.statusCode >= 500) await store.forgetWebhookEvent(provider, eventId);
      throw err;
    }
    return { received: true, duplicate: false };
  });
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
