/**
 * Boot-time setup: migrations, default settings, and the owner actor.
 *
 * Next calls `register()` once per server process, which makes it the right
 * place for work that must happen exactly once — and it means an upgrade is
 * never a manual step an operator can forget. Everything here is idempotent and
 * best-effort: a failure is logged loudly but must not stop the server, because
 * the app can still render a diagnostic page explaining what is wrong.
 */
export async function register(): Promise<void> {
  // Instrumentation is also bundled for the edge runtime, where `pg` cannot
  // run. Importing inside the guard keeps the driver out of that bundle.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { runMigrations, ensureDefaultSettings, ensureOwnerActor } = await import("@cove/db");
  const { getEnvState } = await import("./lib/env");
  const { resolveMigrationsDir } = await import("./lib/paths");

  const envState = getEnvState();
  if (!envState.ok) {
    console.warn(
      "[cove] skipping database setup — configuration is incomplete.\n" +
        "       Run ./setup.sh, then restart. The web UI will show the details.",
    );
    return;
  }

  const env = envState.env;

  try {
    const migrationsDir = resolveMigrationsDir();
    await runMigrations(migrationsDir);
    console.log(`[cove] migrations up to date (${migrationsDir})`);

    await ensureDefaultSettings();
    const actor = await ensureOwnerActor({
      siteUrl: env.siteUrl,
      handle: env.handle,
      displayName: env.siteName,
    });
    console.log(`[cove] actor ready: ${actor.uri}`);
  } catch (error) {
    console.error(
      "[cove] database setup failed. The site will render a diagnostic page.\n" +
        `       ${(error as Error).message}\n` +
        "       Check that the database is running: podman compose logs db",
    );
  }
}
