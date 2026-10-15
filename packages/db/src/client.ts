/**
 * Postgres connection handling.
 *
 * Two details matter for self-hosting:
 *
 *  - The pool is a module-level singleton, because Next.js dev mode re-evaluates
 *    modules on every hot reload and would otherwise leak a pool per reload.
 *  - `migrate()` is exported so migrations run automatically on boot. An upgrade
 *    must never depend on the operator remembering a manual step.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __covePool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __coveDb: Database | undefined;
}

export interface DbOptions {
  readonly connectionString: string;
  /** Conservative by default — a personal site does not need a large pool. */
  readonly max?: number;
}

function createPool(options: DbOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    // Media uploads and long transcodes hold connections far less often than
    // they hold CPU, so a short connect timeout surfaces a misconfigured
    // DATABASE_URL quickly instead of hanging the boot path.
    connectionTimeoutMillis: 10_000,
  });
}

export function getPool(options?: DbOptions): Pool {
  if (!globalThis.__covePool) {
    const connectionString = options?.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set, so Cove cannot reach Postgres.\n" +
          "  If you are running the bundled stack, run `./setup.sh` first.",
      );
    }
    globalThis.__covePool = createPool({ connectionString, max: options?.max });
  }
  return globalThis.__covePool;
}

export function getDb(options?: DbOptions): Database {
  if (!globalThis.__coveDb) {
    globalThis.__coveDb = drizzle(getPool(options), { schema });
  }
  return globalThis.__coveDb;
}

export async function closeDb(): Promise<void> {
  if (globalThis.__covePool) {
    await globalThis.__covePool.end();
    globalThis.__covePool = undefined;
    globalThis.__coveDb = undefined;
  }
}

/** True when the database answers a trivial query. Used by /healthz. */
export async function ping(db: Database = getDb()): Promise<boolean> {
  try {
    await db.execute("select 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply pending migrations. Idempotent, so it is safe to call on every boot.
 * `migrationsFolder` is resolved by the caller because the correct path differs
 * between `next dev` (repo-relative) and the standalone production image.
 */
export async function runMigrations(
  migrationsFolder: string,
  db: Database = getDb(),
): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export { schema };
