import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Cold starts (first import of stellar-sdk) can be slow on CI runners.
    testTimeout: 20_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry point and real network adapters are exercised on testnet, not offline.
      exclude: ["src/server.ts", "src/stellar/gateway.ts", "src/escrow/soroban.ts", "src/store/postgres.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
