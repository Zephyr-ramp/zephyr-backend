import type { PaymentRail } from "./types.js";

export interface WebhookRailOptions {
  /** Provider API base URL, e.g. https://api.your-bank.example/v1 */
  apiUrl: string;
  apiKey: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Skeleton for an asynchronous, webhook-driven bank or BaaS provider.
 *
 * It speaks a small generic HTTP protocol (documented in docs/payment-rails.md):
 *   POST {apiUrl}/deposit-instructions  -> { id, instructions }
 *   POST {apiUrl}/payouts               -> { id }   (settles later via webhook)
 * and the provider calls back `POST /webhooks/rail/webhook` with signed events.
 *
 * To integrate a real provider, copy this file, map its API onto these two
 * calls, and translate its webhook payloads into `RailEvent`s. No real bank is
 * integrated here.
 */
export class WebhookPaymentRail implements PaymentRail {
  readonly name = "webhook";
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: WebhookRailOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async createDepositInstructions(input: {
    transactionId: string;
    amount: string;
    customer: { name: string; email: string };
  }) {
    const res = await this.post<{ id: string; instructions: Record<string, string> }>(
      "/deposit-instructions",
      { reference: input.transactionId, amount: input.amount, currency: "USD", customer: input.customer },
      input.transactionId,
    );
    return { externalId: res.id, instructions: res.instructions };
  }

  async sendPayout(input: { transactionId: string; amount: string; customer: { name: string; email: string } }) {
    const res = await this.post<{ id: string }>(
      "/payouts",
      { reference: input.transactionId, amount: input.amount, currency: "USD", customer: input.customer },
      // Idempotency: retries of the same payout must not pay twice.
      `payout-${input.transactionId}`,
    );
    return { externalId: res.id, status: "pending" as const };
  }

  private async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const res = await this.fetch(`${this.opts.apiUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`rail ${path} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
