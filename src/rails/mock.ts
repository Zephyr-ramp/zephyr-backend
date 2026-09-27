import { randomUUID } from "node:crypto";
import type { PaymentRail } from "./types.js";

/**
 * A fake rail for development and tests. Deposits are "received" by calling
 * POST /sandbox/deposits/:id/fiat-received; payouts succeed instantly.
 */
export class MockPaymentRail implements PaymentRail {
  readonly name = "mock";
  private readonly payouts = new Map<string, string>();

  async createDepositInstructions(input: { transactionId: string; amount: string }) {
    const reference = `ZEPHYR-${input.transactionId.slice(0, 8).toUpperCase()}`;
    return {
      externalId: `mock_dep_${randomUUID()}`,
      instructions: {
        bank_name: "Sandbox Bank (not real)",
        account_name: "Zephyr Sandbox",
        routing_number: "000000000",
        account_number: "000123456789",
        reference,
        amount: `${input.amount} USD`,
      },
    };
  }

  async sendPayout(input: { transactionId: string }) {
    const existing = this.payouts.get(input.transactionId);
    if (existing) return { externalId: existing };
    const externalId = `mock_payout_${randomUUID()}`;
    this.payouts.set(input.transactionId, externalId);
    return { externalId };
  }
}
