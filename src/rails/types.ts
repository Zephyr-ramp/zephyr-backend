/**
 * A PaymentRail moves US dollars in the real world (ACH, wire, card, a banking-as-a-service API...).
 * The anchor core never talks to a bank directly; it only talks to this interface.
 *
 * Rails can be synchronous (the call itself settles the money, like `MockPaymentRail`)
 * or asynchronous: they return `pending` and later report the outcome through
 * `POST /webhooks/rail/:provider` (see `docs/payment-rails.md`).
 */
export interface PaymentRail {
  readonly name: string;

  /**
   * On-ramp: tell the user how to send us dollars for this transaction.
   * The returned fields are shown to the user verbatim (e.g. bank name, account, reference).
   */
  createDepositInstructions(input: {
    transactionId: string;
    amount: string;
    customer: { name: string; email: string };
  }): Promise<{ instructions: Record<string, string>; externalId: string }>;

  /**
   * Off-ramp: pay dollars out to the user once their USDC is secured.
   * Must be idempotent on `transactionId`: calling it twice never pays twice.
   *
   * Returns `completed` if the money has definitely left, or `pending` if the
   * outcome arrives later as a `payout.completed` / `payout.failed` webhook.
   * Throwing means the payout definitely did not happen.
   */
  sendPayout(input: {
    transactionId: string;
    amount: string;
    customer: { name: string; email: string };
  }): Promise<{ externalId: string; status?: "completed" | "pending" }>;
}

/** Events a rail reports through its webhook. */
export type RailEvent =
  | { id: string; type: "deposit.received"; data: { transaction_id: string; amount: string; external_id?: string } }
  | { id: string; type: "payout.completed"; data: { transaction_id: string; external_id?: string } }
  | { id: string; type: "payout.failed"; data: { transaction_id: string; reason?: string } };
