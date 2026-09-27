# Payment rails

A **payment rail** moves US dollars in the real world: ACH, wire, card, or a banking-as-a-service API. The anchor core never talks to a bank directly. It only talks to the `PaymentRail` interface in [`src/rails/types.ts`](../src/rails/types.ts).

Zephyr ships two rails:

| `PAYMENT_RAIL`   | File                                              | What it does                                                                                                                                           |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mock` (default) | [`src/rails/mock.ts`](../src/rails/mock.ts)       | Fake bank details; payouts succeed instantly. Deposits are confirmed with `POST /sandbox/deposits/:id/fiat-received`, or a `deposit.received` webhook. |
| `webhook`        | [`src/rails/webhook.ts`](../src/rails/webhook.ts) | A **skeleton** for an asynchronous provider that speaks the small HTTP protocol below. No real bank is integrated.                                     |

## The interface

```ts
interface PaymentRail {
  readonly name: string;

  // On-ramp: how should the user send us dollars? Shown to the user verbatim.
  createDepositInstructions(input: {
    transactionId;
    amount;
    customer;
  }): Promise<{ instructions: Record<string, string>; externalId: string }>;

  // Off-ramp: pay the user. MUST be idempotent on transactionId.
  sendPayout(input: {
    transactionId;
    amount;
    customer;
  }): Promise<{ externalId: string; status?: "completed" | "pending" }>;
}
```

Rules:

- **Amounts are decimal strings** (`"98.50"`). Never convert them to floats. Use `src/lib/amount.ts`.
- **`sendPayout` must never pay twice** for the same `transactionId`. Pass it to your provider as an idempotency key.
- Return `completed` only when the money has definitely left. Return `pending` if the provider confirms later by webhook.
- **Throw only if the payout definitely did not happen.** A throw on an escrow withdrawal makes the anchor `cancel` the escrow and refund the user on chain. If you're unsure (a timeout, for example), return `pending` and let the webhook decide.

## What happens after a payout

| Withdrawal mode         | `completed`                            | `pending`                                  | throws / `payout.failed`                                             |
| ----------------------- | -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Standard (memo payment) | `completed`                            | stays `pending_external` until the webhook | `error` (manual review: the anchor holds the user's USDC)            |
| Escrow                  | anchor calls `claim`, then `completed` | stays `pending_external` until the webhook | anchor calls `cancel`, so the user is refunded on chain (`refunded`) |

## Webhooks: `POST /webhooks/rail/:provider`

Registered only when `RAIL_WEBHOOK_SECRET` is set. `:provider` must equal the configured rail's `name`.

### Signature

```
Zephyr-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(RAIL_WEBHOOK_SECRET, "<t>.<raw body>")>
```

- The HMAC covers the **exact raw bytes** of the body.
- Timestamps more than **5 minutes** from our clock are rejected (replay protection).
- `signWebhook()` in [`src/lib/signatures.ts`](../src/lib/signatures.ts) produces this header. Use it in tests and adapters.

### Idempotency

Each event is processed **at most once**, keyed by the event `id`, or by the `Idempotency-Key` header if present. A duplicate gets `200 {"received": true, "duplicate": true}`. If processing fails with a server error, the key is released so the provider's retry is processed.

### Events

```jsonc
// Dollars arrived for a deposit. `amount` must equal the quoted amount,
// otherwise the transaction goes to `error` and nothing is paid.
{ "id": "evt_1", "type": "deposit.received",
  "data": { "transaction_id": "<zephyr id>", "amount": "100.00", "external_id": "bank-ref" } }

// An asynchronous payout settled.
{ "id": "evt_2", "type": "payout.completed",
  "data": { "transaction_id": "<zephyr id>", "external_id": "bank-ref" } }

// An asynchronous payout failed.
{ "id": "evt_3", "type": "payout.failed",
  "data": { "transaction_id": "<zephyr id>", "reason": "account closed" } }
```

Responses: `200` processed or duplicate, `400` malformed, `401` bad or stale signature, `404` unknown provider or transaction, `409` the event doesn't fit the transaction's current state (it stays recorded, so retrying won't help).

### Try it locally

```bash
SECRET=whsec_local_0123456789
BODY='{"id":"evt_1","type":"deposit.received","data":{"transaction_id":"<id>","amount":"100.00"}}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST localhost:8080/webhooks/rail/mock \
  -H 'content-type: application/json' \
  -H "zephyr-signature: t=$T,v1=$SIG" \
  -d "$BODY"
```

## The `webhook` rail's provider protocol

`WebhookPaymentRail` expects a provider (or an adapter service in front of one) at `RAIL_API_URL`:

| Call                                       | Request                                                                                            | Response                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `POST {RAIL_API_URL}/deposit-instructions` | `{ reference, amount, currency: "USD", customer }`                                                 | `{ id, instructions: { ...string fields } }` |
| `POST {RAIL_API_URL}/payouts`              | `{ reference, amount, currency: "USD", customer }` with `Idempotency-Key: payout-<transaction id>` | `{ id }` (the outcome arrives by webhook)    |

Both requests carry `Authorization: Bearer <RAIL_API_KEY>`.

## Adding a real provider

1. Copy `src/rails/webhook.ts` to `src/rails/<provider>.ts` and map the provider's API onto the two calls. Keep payouts idempotent.
2. Translate the provider's webhook payloads into the three events above. Either add a small translation layer in `src/webhooks/routes.ts` keyed by provider, or run an adapter that re-signs events in Zephyr's format.
3. Add the provider to `PAYMENT_RAIL` in `src/config.ts` with its own env vars, and document them in `.env.example` and the README.
4. Test with a fake `fetch` (see `test/webhooks.test.ts`). Tests must not call the real provider.
