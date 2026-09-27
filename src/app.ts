import formbody from "@fastify/formbody";
import proxy from "@fastify/http-proxy";
import multipart from "@fastify/multipart";
import rateLimitPlugin from "@fastify/rate-limit";
import Fastify, { type FastifyRequest } from "fastify";
import { interactiveApiRoutes } from "./api/interactive.js";
import type { Config } from "./config.js";
import { SandboxEscrowGateway } from "./escrow/sandbox.js";
import { SorobanEscrowGateway } from "./escrow/soroban.js";
import type { EscrowGateway } from "./escrow/types.js";
import { EscrowWatcher } from "./escrow/watcher.js";
import { AnchorError } from "./lib/errors.js";
import { type CallbackNotifier, HttpCallbackNotifier } from "./notify/callbacks.js";
import { MockPaymentRail } from "./rails/mock.js";
import type { PaymentRail } from "./rails/types.js";
import { WebhookPaymentRail } from "./rails/webhook.js";
import { sandboxRoutes } from "./sandbox/routes.js";
import { sep1Routes } from "./sep1/routes.js";
import { sep10Routes } from "./sep10/routes.js";
import { sep24Routes } from "./sep24/routes.js";
import { TransferService } from "./sep24/service.js";
import { HorizonStellarGateway, type StellarGateway } from "./stellar/gateway.js";
import { InMemoryTransactionStore } from "./store/memory.js";
import { PostgresTransactionStore } from "./store/postgres.js";
import type { TransactionStore } from "./store/types.js";
import { webhookRoutes } from "./webhooks/routes.js";

export interface AppDeps {
  store?: TransactionStore;
  rail?: PaymentRail;
  stellar?: StellarGateway;
  /** Pass `null` to disable escrow withdrawals even when the sandbox is on. */
  escrow?: EscrowGateway | null;
  notifier?: CallbackNotifier;
}

/** Strip secrets (interactive / more_info tokens) from logged URLs. */
function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, "$1[redacted]");
}

export async function buildApp(config: Config, deps: AppDeps = {}) {
  const app = Fastify({
    logger:
      config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            redact: ["req.headers.authorization", "req.headers['zephyr-signature']"],
            serializers: {
              req: (req: FastifyRequest) => ({
                method: req.method,
                url: redactUrl(req.url),
                ip: req.ip,
                reqId: req.id,
              }),
            },
          },
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  const store =
    deps.store ??
    (config.databaseUrl ? await PostgresTransactionStore.connect(config.databaseUrl) : new InMemoryTransactionStore());
  if (!deps.store && !config.databaseUrl)
    app.log.warn("DATABASE_URL not set: using the in-memory store (data is lost on restart)");

  const rail =
    deps.rail ??
    (config.paymentRail === "webhook"
      ? new WebhookPaymentRail({ apiUrl: config.rail.apiUrl!, apiKey: config.rail.apiKey! })
      : new MockPaymentRail());
  const stellar =
    deps.stellar ??
    new HorizonStellarGateway(
      config.horizonUrl,
      config.networkPassphrase,
      config.distributionKeypair,
      config.asset,
      app.log,
    );

  let escrow: EscrowGateway | undefined;
  if (deps.escrow !== undefined) {
    escrow = deps.escrow ?? undefined;
  } else if (config.escrow.contractId) {
    escrow = new SorobanEscrowGateway({
      rpcUrl: config.sorobanRpcUrl,
      networkPassphrase: config.networkPassphrase,
      contractId: config.escrow.contractId,
      anchorSecret: config.escrow.anchorSecret,
      startLedger: config.escrow.startLedger,
      log: app.log,
    });
  } else if (config.enableSandbox) {
    escrow = new SandboxEscrowGateway();
    app.log.warn("escrow withdrawals use the in-memory sandbox escrow (no chain)");
  }

  const notifier = deps.notifier ?? new HttpCallbackNotifier(config.signingKeypair, app.log);
  const service = new TransferService(config, store, rail, stellar, app.log, escrow, notifier);
  const escrowWatcher = escrow
    ? new EscrowWatcher(escrow, store, service, app.log, config.escrow.pollIntervalMs)
    : undefined;

  await app.register(rateLimitPlugin, { global: false });
  const rateLimit = { max: config.rateLimit.max, timeWindow: config.rateLimit.windowMs };
  await app.register(formbody);
  await app.register(multipart, { attachFieldsToBody: "keyValues", limits: { fileSize: 1_000_000, files: 1 } });

  // SEP-1, SEP-10 and SEP-24 all require permissive CORS so browser wallets can call us.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      reply
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .code(204)
        .send();
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AnchorError) {
      return reply.code(err.statusCode).send({ error: err.message, ...err.body });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal server error" });
  });

  /** Liveness: the process is up. */
  app.get("/health", async () => ({ status: "ok", network: config.network, rail: rail.name }));

  /** Readiness: dependencies are reachable, so traffic can be routed here. */
  app.get("/ready", async (_request, reply) => {
    const checks: Record<string, string> = {};
    try {
      await store.ping();
      checks.store = "ok";
    } catch {
      checks.store = "unavailable";
    }
    if (escrowWatcher) checks.escrow_watcher = escrowWatcher.lastError ? `error: ${escrowWatcher.lastError}` : "ok";
    const ready = checks.store === "ok";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });

  app.get("/openapi.yaml", async (_request, reply) => {
    const { readFile } = await import("node:fs/promises");
    const spec = await readFile(new URL("../openapi.yaml", import.meta.url), "utf8");
    return reply.type("application/yaml").send(spec);
  });

  await app.register(sep1Routes, { config });
  await app.register(sep10Routes, { config, stellar, rateLimit });
  await app.register(sep24Routes, { prefix: "/sep24", config, service, store, rateLimit });
  await app.register(interactiveApiRoutes, { config, service, rateLimit });

  if (config.rail.webhookSecret) {
    await app.register(webhookRoutes, { secret: config.rail.webhookSecret, rail, service, store });
  }

  // Interactive pages live in zephyr-frontend but must be served from the anchor's domain.
  if (config.frontendUrl) {
    for (const prefix of ["/sep24/interactive/", "/_next/"]) {
      await app.register(proxy, { upstream: config.frontendUrl, prefix, rewritePrefix: prefix });
    }
  }

  if (config.enableSandbox) {
    await app.register(sandboxRoutes, { prefix: "/sandbox", config, service, store, escrow, escrowWatcher });
    app.log.warn("sandbox endpoints enabled; do not use in production");
  }

  app.addHook("onClose", async () => {
    await escrowWatcher?.stop();
    await store.close();
  });

  return { app, service, stellar, store, escrow, escrowWatcher };
}
