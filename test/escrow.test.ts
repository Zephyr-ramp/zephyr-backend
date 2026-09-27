import { Address, nativeToScVal, xdr } from "@zephyr-ramp/escrow-client";
import { describe, expect, it } from "vitest";
import { SandboxEscrowGateway } from "../src/escrow/sandbox.js";
import { decodeEvent } from "../src/escrow/soroban.js";
import { escrowTxId } from "../src/escrow/types.js";
import { toStroops } from "../src/lib/amount.js";
import { ControllableRail, getTx, startTx, submitApi, testApp } from "./helpers.js";

async function setup(opts: { rail?: ControllableRail; env?: Record<string, string> } = {}) {
  const escrow = new SandboxEscrowGateway();
  const rail = opts.rail ?? new ControllableRail();
  const ctx = await testApp(opts.env ?? {}, { escrow, rail });
  const t = await startTx(ctx, "withdraw");
  const res = await submitApi(ctx, t.id, t.interactiveToken, { amount: "50", withdraw_mode: "escrow" });
  expect(res.statusCode).toBe(200);
  const txId = escrowTxId(t.id);
  const lock = (over: { amount?: bigint; user?: string; timeout?: number } = {}) =>
    escrow.lock({
      txId,
      user: over.user ?? t.client.publicKey(),
      amount: over.amount ?? toStroops("50"),
      timeoutLedgers: over.timeout ?? 17_280,
    });
  return { ...ctx, ...t, escrow, rail, txId, lock, watcher: ctx.escrowWatcher! };
}

describe("escrow tx_id", () => {
  it("is the sha256 hex of the transaction id", () => {
    expect(escrowTxId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("escrow withdrawals", () => {
  it("exposes escrow instructions after the form, not a memo", async () => {
    const s = await setup();
    const tx = await getTx(s, s.token, s.id);
    expect(tx).toMatchObject({
      status: "pending_user_transfer_start",
      withdraw_mode: "escrow",
      withdraw_anchor_account: null,
      withdraw_memo: null,
      escrow: { contract_id: "SANDBOX_ESCROW", tx_id: s.txId, amount: "50.00", timeout_ledgers: 17280 },
    });
  });

  it("locked -> payout -> claim -> completed", async () => {
    const s = await setup();
    s.lock();
    // One poll drains both the lock and the `claimed` event our own claim emitted.
    expect(await s.watcher.poll()).toBe(2);
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("completed");
    expect(tx.escrow.claim_tx_hash).toMatch(/^sandbox_/);
    expect(s.escrow.status(s.txId)).toBe("Claimed");
    expect(s.rail.payouts).toEqual([s.id]);

    const audit = (await s.store.auditLog(s.id)).map((a) => a.toStatus);
    expect(audit).toEqual([
      "incomplete",
      "pending_user_transfer_start",
      "pending_anchor",
      "pending_external",
      "pending_stellar",
      "completed",
    ]);
    expect(await s.watcher.poll()).toBe(0);
    expect((await getTx(s, s.token, s.id)).status).toBe("completed");
  });

  it("cancels on-chain and marks refunded when the payout fails", async () => {
    const rail = new ControllableRail();
    rail.payoutMode = "throw";
    const s = await setup({ rail });
    s.lock();
    await s.watcher.poll();
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("refunded");
    expect(tx.refunded).toBe(true);
    expect(tx.refunds).toEqual({
      amount_refunded: "50.00",
      amount_fee: "0.00",
      payments: [{ id: tx.escrow.refund_tx_hash, id_type: "stellar", amount: "50.00", fee: "0.00" }],
    });
    expect(s.escrow.status(s.txId)).toBe("Refunded");
  });

  it("claims after an asynchronous payout.completed webhook", async () => {
    const rail = new ControllableRail();
    rail.payoutMode = "pending";
    const s = await setup({ rail });
    s.lock();
    await s.watcher.poll();
    expect((await getTx(s, s.token, s.id)).status).toBe("pending_external");
    await s.service.handlePayoutResult(s.id, { ok: true });
    expect((await getTx(s, s.token, s.id)).status).toBe("completed");
    expect(s.escrow.status(s.txId)).toBe("Claimed");
  });

  it("cancels after an asynchronous payout.failed webhook", async () => {
    const rail = new ControllableRail();
    rail.payoutMode = "pending";
    const s = await setup({ rail });
    s.lock();
    await s.watcher.poll();
    await s.service.handlePayoutResult(s.id, { ok: false, reason: "bank rejected" });
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("refunded");
    expect(tx.message).toMatch(/bank rejected/);
  });

  it("sends a wrong amount to error without paying or claiming", async () => {
    const s = await setup();
    s.lock({ amount: toStroops("49.9999999") });
    await s.watcher.poll();
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("error");
    expect(tx.message).toMatch(/expected 50.00/);
    expect(s.rail.payouts).toEqual([]);
    expect(s.escrow.status(s.txId)).toBe("Locked"); // user can refund after expiry
  });

  it("sends a lock from another account to error", async () => {
    const s = await setup();
    s.lock({ user: "GSOMEONEELSE" });
    await s.watcher.poll();
    expect((await getTx(s, s.token, s.id)).status).toBe("error");
    expect(s.rail.payouts).toEqual([]);
  });

  it("cancels instead of paying when the escrow expires too soon", async () => {
    const s = await setup({ env: { ESCROW_MIN_REMAINING_LEDGERS: "1000" } });
    s.lock({ timeout: 720 });
    await s.watcher.poll();
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("refunded");
    expect(tx.message).toMatch(/expires too soon/);
    expect(s.rail.payouts).toEqual([]);
  });

  it("goes to error (not completed) if the claim fails after paying out", async () => {
    const s = await setup();
    s.escrow.failClaim = true;
    s.lock();
    await s.watcher.poll();
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("error");
    expect(tx.message).toMatch(/claim failed/);
  });

  it("goes to error if both the payout and the cancel fail", async () => {
    const rail = new ControllableRail();
    rail.payoutMode = "throw";
    const s = await setup({ rail });
    s.escrow.failCancel = true;
    s.lock();
    await s.watcher.poll();
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("error");
    expect(tx.message).toMatch(/user can refund after ledger/);
  });

  it("marks refunded when the user refunds an expired escrow the anchor never processed", async () => {
    const rail = new ControllableRail();
    rail.payoutMode = "pending";
    const s = await setup({ rail });
    // Lock arrives, but we skip processing it (e.g. watcher was down) until after expiry.
    const lock = s.lock({ timeout: 720 });
    s.escrow.advance(720);
    const refund = s.escrow.refund(s.txId);
    // Process only the refund event.
    await s.service.handleEscrowRefunded(refund as never);
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("refunded");
    expect(tx.message).toMatch(/after the escrow expired/);
    expect(lock.type).toBe("locked");
  });

  it("flags a refund that lands while the payout is in flight", async () => {
    const rail = new ControllableRail();
    rail.payoutMode = "pending";
    const s = await setup({ rail });
    s.lock({ timeout: 720 });
    await s.watcher.poll();
    s.escrow.advance(720);
    s.escrow.refund(s.txId);
    await s.watcher.poll();
    const tx = await getTx(s, s.token, s.id);
    expect(tx.status).toBe("error");
    expect(tx.message).toMatch(/refunded on chain while the payout was pending_external/);
  });

  it("ignores locks for unknown transactions and replays of handled events", async () => {
    const s = await setup();
    s.escrow.lock({ txId: "ff".repeat(32), user: "GX", amount: 1n, timeoutLedgers: 720 });
    const event = s.lock();
    await s.watcher.poll();
    const replay = await s.service.handleEscrowLocked(event as never);
    expect(replay?.status).toBe("completed");
    expect(s.rail.payouts).toEqual([s.id]);
  });

  it("persists the watcher cursor so a restart doesn't reprocess", async () => {
    const s = await setup();
    s.lock();
    await s.watcher.poll();
    expect(await s.store.getCursor(`escrow:SANDBOX_ESCROW`)).toBe("2");
    expect(await s.watcher.poll()).toBe(0);
  });

  it("does not let the Horizon watcher touch escrow withdrawals", async () => {
    const s = await setup();
    const res = await s.service.handleStellarPayment({
      transactionHash: "h",
      from: s.client.publicKey(),
      amount: "50",
      assetCode: "USDC",
      assetIssuer: s.config.asset.issuer,
      memo: "anything",
    });
    expect(res).toBeUndefined();
  });

  it("start/stop runs the polling loop", async () => {
    const s = await setup();
    s.lock();
    s.watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    await s.watcher.stop();
    expect((await getTx(s, s.token, s.id)).status).toBe("completed");
    expect(s.watcher.lastPollAt).toBeInstanceOf(Date);
  });
});

describe("Soroban event decoding", () => {
  const contract = "CCQCVQTYB45FXJG6BPLR4RPBMBOE4VD73MUMTDWT6Q55TXINSEBV3IOQ";
  const user = "GDPUX6JJNDRAWPA2EDERIICH57GSYNCMEBMB4XMIISW462BGIKOIR6DT";
  const txIdBytes = Buffer.alloc(32, 0xab);
  const map = (entries: Record<string, xdr.ScVal>) =>
    xdr.ScVal.scvMap(
      Object.keys(entries)
        .sort()
        .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: entries[k]! })),
    );
  const event = (name: string, value: xdr.ScVal) => ({
    id: "0001",
    ledger: 42,
    txHash: "hash",
    topic: [xdr.ScVal.scvSymbol(name), xdr.ScVal.scvBytes(txIdBytes)],
    value,
  });

  it("decodes locked, claimed and refunded", () => {
    const addr = new Address(user).toScVal();
    const amount = nativeToScVal(500_000_000n, { type: "i128" });
    expect(decodeEvent(event("locked", map({ user: addr, amount, expires_ledger: xdr.ScVal.scvU32(9000) })))).toEqual({
      type: "locked",
      id: "0001",
      ledger: 42,
      txHash: "hash",
      txId: "ab".repeat(32),
      user,
      amount: 500_000_000n,
      expiresLedger: 9000,
    });
    expect(decodeEvent(event("claimed", map({ anchor: new Address(contract).toScVal(), amount })))).toMatchObject({
      type: "claimed",
      anchor: contract,
      amount: 500_000_000n,
    });
    expect(
      decodeEvent(event("refunded", map({ user: addr, amount, by_anchor: xdr.ScVal.scvBool(true) }))),
    ).toMatchObject({ type: "refunded", user, byAnchor: true });
  });

  it("ignores admin events and malformed topics", () => {
    expect(
      decodeEvent({ id: "1", ledger: 1, txHash: "h", topic: [xdr.ScVal.scvSymbol("paused_changed")], value: map({}) }),
    ).toBeUndefined();
    expect(decodeEvent(event("upgraded", map({})))).toBeUndefined();
    expect(
      decodeEvent({
        id: "1",
        ledger: 1,
        txHash: "h",
        topic: [xdr.ScVal.scvSymbol("locked"), xdr.ScVal.scvU32(1)],
        value: map({}),
      }),
    ).toBeUndefined();
  });
});
