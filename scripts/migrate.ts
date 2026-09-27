/**
 * Applies pending database migrations (drizzle/) to DATABASE_URL and exits.
 * The server also does this on startup; this script is for CI/CD pipelines.
 * Usage: DATABASE_URL=postgres://... npm run db:migrate
 */
import "dotenv/config";
import { PostgresTransactionStore } from "../src/store/postgres.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const store = await PostgresTransactionStore.connect(url);
await store.close();
console.log("migrations applied");
