import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { InMemoryTransactionStore } from "../src/store/memory.js";
import { MIGRATIONS_FOLDER, PostgresTransactionStore } from "../src/store/postgres.js";
import * as schema from "../src/store/schema.js";
import { storeContract } from "./store-contract.js";

storeContract("in-memory", async () => new InMemoryTransactionStore());

// PGlite is real Postgres compiled to WASM: the Postgres store and the committed
// migrations are exercised offline, with no Docker.
const pglite = new PGlite();
const db = drizzle(pglite, { schema });
const migrated = migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
storeContract(
  "postgres (PGlite)",
  async () => {
    await migrated;
    return new PostgresTransactionStore(db);
  },
  () => pglite.close(),
);
