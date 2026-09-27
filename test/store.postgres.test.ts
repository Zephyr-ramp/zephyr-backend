import { execSync } from "node:child_process";
import { describe, it } from "vitest";
import { PostgresTransactionStore } from "../src/store/postgres.js";
import { storeContract } from "./store-contract.js";

/**
 * The same store contract against a real PostgreSQL server in Docker
 * (testcontainers), through the production `node-postgres` driver. Skipped when
 * Docker isn't available; PGlite still covers the SQL in store.test.ts.
 */
function dockerAvailable(): boolean {
  if (process.env.SKIP_DOCKER_TESTS === "true") return false;
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

if (dockerAvailable()) {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const store = await PostgresTransactionStore.connect(container.getConnectionUri());
  storeContract(
    "postgres (testcontainers)",
    async () => store,
    async () => {
      await store.close();
      await container.stop();
    },
  );
} else {
  describe("TransactionStore: postgres (testcontainers)", () => {
    it.skip("skipped: Docker is not available", () => {});
  });
}
