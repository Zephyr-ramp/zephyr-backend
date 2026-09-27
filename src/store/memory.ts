import type { AuditContext, AuditEntry, ListFilter, Transaction, TransactionPatch, TransactionStore } from "./types.js";

/** Non-durable store for tests and quick local runs. Everything is lost on restart. */
export class InMemoryTransactionStore implements TransactionStore {
  private readonly txs = new Map<string, Transaction>();
  private readonly audits: AuditEntry[] = [];
  private readonly cursors = new Map<string, string>();
  private readonly webhookEvents = new Set<string>();

  async create(input: Omit<Transaction, "startedAt" | "updatedAt">, audit?: AuditContext): Promise<Transaction> {
    if (this.txs.has(input.id)) throw new Error(`Transaction ${input.id} already exists`);
    const now = new Date();
    const tx: Transaction = { ...input, startedAt: now, updatedAt: now };
    this.txs.set(tx.id, tx);
    this.audits.push({
      transactionId: tx.id,
      fromStatus: null,
      toStatus: tx.status,
      actor: audit?.actor ?? "system",
      note: audit?.note,
      at: now,
    });
    return clone(tx);
  }

  async get(id: string): Promise<Transaction | undefined> {
    const tx = this.txs.get(id);
    return tx ? clone(tx) : undefined;
  }

  async findByWithdrawMemo(memo: string): Promise<Transaction | undefined> {
    for (const tx of this.txs.values()) {
      if (tx.kind === "withdrawal" && tx.withdrawMemo === memo) return clone(tx);
    }
    return undefined;
  }

  async findByEscrowTxId(txIdHex: string): Promise<Transaction | undefined> {
    const wanted = txIdHex.toLowerCase();
    for (const tx of this.txs.values()) {
      if (tx.escrow?.txId === wanted) return clone(tx);
    }
    return undefined;
  }

  async update(id: string, patch: TransactionPatch, audit?: AuditContext): Promise<Transaction> {
    const existing = this.txs.get(id);
    if (!existing) throw new Error(`Transaction ${id} not found`);
    const updated: Transaction = { ...existing, ...patch, updatedAt: new Date() };
    this.txs.set(id, updated);
    if (patch.status && patch.status !== existing.status) {
      this.audits.push({
        transactionId: id,
        fromStatus: existing.status,
        toStatus: patch.status,
        actor: audit?.actor ?? "system",
        note: audit?.note,
        at: updated.updatedAt,
      });
    }
    return clone(updated);
  }

  async list(filter: ListFilter): Promise<Transaction[]> {
    const before = filter.pagingId ? this.txs.get(filter.pagingId)?.startedAt : undefined;
    return [...this.txs.values()]
      .filter((tx) => tx.account === filter.account)
      .filter((tx) => !filter.assetCode || tx.assetCode === filter.assetCode)
      .filter((tx) => !filter.kind || tx.kind === filter.kind)
      .filter((tx) => !filter.noOlderThan || tx.startedAt >= filter.noOlderThan)
      .filter((tx) => !before || tx.startedAt < before)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, filter.limit ?? 100)
      .map(clone);
  }

  async auditLog(transactionId: string): Promise<AuditEntry[]> {
    return this.audits.filter((a) => a.transactionId === transactionId).map((a) => ({ ...a }));
  }

  async getCursor(name: string) {
    return this.cursors.get(name);
  }

  async setCursor(name: string, value: string) {
    this.cursors.set(name, value);
  }

  async recordWebhookEvent(provider: string, eventId: string) {
    const key = webhookKey(provider, eventId);
    if (this.webhookEvents.has(key)) return false;
    this.webhookEvents.add(key);
    return true;
  }

  async forgetWebhookEvent(provider: string, eventId: string) {
    this.webhookEvents.delete(webhookKey(provider, eventId));
  }

  async ping() {}
  async close() {}
}

function webhookKey(provider: string, eventId: string) {
  return JSON.stringify([provider, eventId]);
}

function clone(tx: Transaction): Transaction {
  return structuredClone(tx);
}
