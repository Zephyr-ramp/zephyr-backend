import type { TransferService } from "../sep24/service.js";
import type { TransactionStore } from "../store/types.js";
import type { EscrowEvent, EscrowGateway } from "./types.js";

type Logger = {
  info: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

/**
 * Polls the escrow contract's events (Soroban RPC `getEvents`) and hands them
 * to the TransferService. The cursor is saved after each page of events, so a
 * restart resumes where it stopped. Handlers are idempotent, so replaying
 * events after a crash mid-page is safe.
 */
export class EscrowWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  lastPollAt: Date | undefined;
  lastError: string | undefined;

  constructor(
    private readonly gateway: EscrowGateway,
    private readonly store: TransactionStore,
    private readonly service: TransferService,
    private readonly log: Logger,
    private readonly intervalMs = 5_000,
  ) {}

  get cursorName() {
    return `escrow:${this.gateway.contractId}`;
  }

  /** Processes every event available now. Returns the number handled. */
  async poll(): Promise<number> {
    let handled = 0;
    // Drain in pages until RPC has nothing new.
    for (;;) {
      const cursor = await this.store.getCursor(this.cursorName);
      const { events, cursor: next } = await this.gateway.fetchEvents(cursor);
      for (const event of events) {
        await this.handle(event);
        handled++;
      }
      if (next && next !== cursor) await this.store.setCursor(this.cursorName, next);
      if (events.length === 0 || !next || next === cursor) break;
    }
    this.lastPollAt = new Date();
    this.lastError = undefined;
    return handled;
  }

  start() {
    const tick = () => {
      this.running = this.poll()
        .then((n) => {
          if (n > 0) this.log.info({ handled: n }, "escrow events processed");
        })
        .catch((err: unknown) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          this.log.error({ err }, "escrow watcher poll failed; will retry");
        })
        .finally(() => {
          this.timer = setTimeout(tick, this.intervalMs);
        });
    };
    tick();
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async handle(event: EscrowEvent) {
    switch (event.type) {
      case "locked":
        return this.service.handleEscrowLocked(event);
      case "claimed":
        return this.service.handleEscrowClaimed(event);
      case "refunded":
        return this.service.handleEscrowRefunded(event);
    }
  }
}
