import { defineConfig } from "drizzle-kit";

/**
 * Migrations are forward-only and numbered, and they run automatically on
 * startup. That is a deliberate product decision: an upgrade must never be a
 * manual step a self-hoster can forget halfway through (docs/PLAN.md §9).
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://cove:cove@localhost:5432/cove",
  },
});
