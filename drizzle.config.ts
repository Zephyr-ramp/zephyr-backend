import { defineConfig } from "drizzle-kit";

// `npm run db:generate` turns changes in src/store/schema.ts into a new SQL
// migration in drizzle/. Commit the generated files. Migrations run
// automatically when the server starts with DATABASE_URL set.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/store/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://zephyr:zephyr@localhost:5432/zephyr" },
});
