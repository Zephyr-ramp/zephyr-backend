import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Transaction, TransactionStore } from "../src/store/types.js";

type NewTx = Omit<Transaction, "startedAt" | "updatedAt">;

const tx = (over: Partial<NewTx> = {}): NewTx => ({
  id: randomUUID(),
  kind: "deposit",
  status: "incomplete",
  account: "GACCOUNT",
  assetCode: "USDC",
  assetIssuer: "GISSUER",
  ...over,
});

/**
 * Behaviour every TransactionStore must have. Run against each implementation
 * so the in-memory store used in tests can't drift from Postgres.
 */
export function storeContract(name: string, make: () => Promise<TransactionStore>, cleanup?: () => Promise<void>) {
  describe(`TransactionStore: ${name}`, () => {
    let store: TransactionStore;
    beforeEach(async () => {
      store = await make();
    });
    afterAll(async () => {
      await cleanup?.();
    });

    it("creates and reads back identical transactions", async () => {
      const input = tx({
        amountIn: "10.00",
        customer: { name: "Ada", email: "a@b.co" },
        depositInstructions: { reference: "R1" },
        lang: "en",
      });
      const created = await store.create(input);
      expect(created.startedAt).toBeInstanceOf(Date);
      const read = await store.get(input.id);
      expect(read).toEqual(created);
      expect(read).not.toHaveProperty("message"); // absent, not null
    });

    it("returns undefined for unknown ids", async () => {
      expect(await store.get(randomUUID())).toBeUndefined();
    });

    it("updates fields and writes an audit entry per status change", async () => {
      const { id } = await store.create(tx(), { actor: "user:GACCOUNT" });
      await store.update(id, { status: "pending_user_transfer_start", amountIn: "5.00" }, { actor: "user:GACCOUNT" });
      await store.update(id, { message: "no status change" });
      const final = await store.update(id, { status: "pending_anchor" }, { actor: "rail:mock", note: "webhook" });
      expect(final.amountIn).toBe("5.00");
      expect(final.message).toBe("no status change");

      const audit = await store.auditLog(id);
      expect(audit.map((a) => [a.fromStatus, a.toStatus, a.actor])).toEqual([
        [null, "incomplete", "user:GACCOUNT"],
        ["incomplete", "pending_user_transfer_start", "user:GACCOUNT"],
        ["pending_user_transfer_start", "pending_anchor", "rail:mock"],
      ]);
      expect(audit[2]!.note).toBe("webhook");
    });

    it("finds withdrawals by memo and escrows by tx_id", async () => {
      const w = await store.create(tx({ kind: "withdrawal", withdrawMemo: `memo${randomUUID().slice(0, 8)}` }));
      const txId = randomUUID().replace(/-/g, "").padEnd(64, "a");
      const e = await store.create(
        tx({ kind: "withdrawal", withdrawMode: "escrow", escrow: { contractId: "CESCROW", txId } }),
      );
      expect((await store.findByWithdrawMemo(w.withdrawMemo!))?.id).toBe(w.id);
      expect((await store.findByEscrowTxId(txId.toUpperCase()))?.id).toBe(e.id);
      expect(await store.findByWithdrawMemo("nope")).toBeUndefined();
      expect(await store.findByEscrowTxId("00")).toBeUndefined();
    });

    it("lists by account, newest first, with filters and paging", async () => {
      const account = `G${randomUUID()}`;
      const ids: string[] = [];
      for (const kind of ["deposit", "withdrawal", "deposit"] as const) {
        ids.push((await store.create(tx({ account, kind }))).id);
        await new Promise((r) => setTimeout(r, 5));
      }
      await store.create(tx({ account: "GOTHER" }));

      const all = await store.list({ account });
      expect(all.map((t) => t.id)).toEqual([...ids].reverse());
      expect((await store.list({ account, kind: "deposit" })).length).toBe(2);
      expect((await store.list({ account, limit: 1 })).map((t) => t.id)).toEqual([ids[2]]);
      expect((await store.list({ account, pagingId: ids[2] })).map((t) => t.id)).toEqual([ids[1], ids[0]]);
      expect(await store.list({ account, noOlderThan: new Date(Date.now() + 60_000) })).toEqual([]);
    });

    it("persists cursors", async () => {
      const name = `horizon:${randomUUID()}`;
      expect(await store.getCursor(name)).toBeUndefined();
      await store.setCursor(name, "1");
      await store.setCursor(name, "2");
      expect(await store.getCursor(name)).toBe("2");
    });

    it("records webhook events once, and can forget them", async () => {
      const id = randomUUID();
      expect(await store.recordWebhookEvent("mock", id)).toBe(true);
      expect(await store.recordWebhookEvent("mock", id)).toBe(false);
      expect(await store.recordWebhookEvent("other", id)).toBe(true);
      await store.forgetWebhookEvent("mock", id);
      expect(await store.recordWebhookEvent("mock", id)).toBe(true);
    });

    it("pings", async () => {
      await expect(store.ping()).resolves.toBeUndefined();
    });

    it("throws when updating an unknown transaction", async () => {
      await expect(store.update(randomUUID(), { status: "error" })).rejects.toThrow(/not found/);
    });
  });
}
