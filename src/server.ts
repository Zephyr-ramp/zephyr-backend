import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const HORIZON_CURSOR = "horizon:payments";

async function main() {
  const config = loadConfig();
  const { app, service, stellar, store, escrowWatcher } = await buildApp(config);

  let stopWatcher: (() => void) | undefined;
  if (config.enableWithdrawalWatcher) {
    // Resume from the last processed payment so restarts never miss a withdrawal.
    const cursor = await store.getCursor(HORIZON_CURSOR);
    stopWatcher = stellar.watchIncomingPayments((payment) => service.handleStellarPayment(payment).then(() => {}), {
      cursor,
      onCursor: (c) => store.setCursor(HORIZON_CURSOR, c),
    });
    app.log.info(
      { account: config.distributionKeypair.publicKey(), cursor: cursor ?? "now" },
      "watching for incoming withdrawals",
    );
  }
  if (escrowWatcher && config.enableEscrowWatcher) {
    escrowWatcher.start();
    app.log.info({ contract: config.escrow.contractId ?? "sandbox" }, "watching escrow events");
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    stopWatcher?.();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
