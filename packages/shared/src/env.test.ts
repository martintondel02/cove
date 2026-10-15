/**
 * Regression tests for configuration parsing.
 *
 * Run with `pnpm test` (Node's built-in runner — no test framework, no deps).
 * These exist because `z.coerce.boolean()` silently inverted every feature flag:
 * it coerces via `Boolean(value)`, and `Boolean("false")` is `true`. So
 * `COVE_LIVE_ENABLED=false` turned live streaming on, and
 * `COVE_FEDERATION_ENABLED=false` opened the inbox. That shipped, ran, and was
 * caught only by an endpoint returning 501 where 403 was expected.
 *
 * The lesson is that environment parsing deserves tests as much as business
 * logic, because it fails silently and in the opposite direction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EnvError, isUsingDevSecret, loadEnv } from "./env.ts";

/** A minimal, valid environment. Individual tests override single keys. */
const BASE = {
  COVE_SITE_URL: "https://cove.example.com",
  COVE_HANDLE: "me",
  DATABASE_URL: "postgres://cove:cove@db:5432/cove",
  COVE_SESSION_SECRET: "a".repeat(64),
  COVE_SECRET_KEY: "b".repeat(64),
} satisfies Record<string, string>;

function envWith(overrides: Record<string, string | undefined> = {}) {
  return { ...BASE, ...overrides };
}

/**
 * Matcher for `assert.throws` that narrows the error type and asserts the
 * message is actionable. `assert.ok(error instanceof EnvError)` does *not*
 * narrow here, because `assert.ok`'s signature only promises truthiness.
 */
function envErrorMatching(fragment: RegExp) {
  return (error: unknown): boolean => {
    if (!(error instanceof EnvError)) {
      throw new Error(`Expected an EnvError, received: ${String(error)}`);
    }
    assert.match(error.message, fragment);
    return true;
  };
}

describe("boolean flags", () => {
  // The exact bug that motivated this file.
  it('parses "false" as false for every flag', () => {
    const env = loadEnv(
      envWith({
        COVE_LIVE_ENABLED: "false",
        COVE_FEDERATION_ENABLED: "false",
        COVE_FEDERATION_ALLOW_REPLIES: "false",
      }),
    );
    assert.equal(env.liveEnabled, false);
    assert.equal(env.federationEnabled, false);
    assert.equal(env.federationAllowReplies, false);
  });

  it('parses "true" as true', () => {
    const env = loadEnv(
      envWith({
        COVE_LIVE_ENABLED: "true",
        COVE_FEDERATION_ENABLED: "true",
        COVE_FEDERATION_ALLOW_REPLIES: "true",
      }),
    );
    assert.equal(env.liveEnabled, true);
    assert.equal(env.federationEnabled, true);
    assert.equal(env.federationAllowReplies, true);
  });

  it("treats other affirmative spellings as true, and everything else as false", () => {
    for (const truthy of ["1", "yes", "on", "TRUE", " Yes "]) {
      assert.equal(loadEnv(envWith({ COVE_LIVE_ENABLED: truthy })).liveEnabled, true, truthy);
    }
    // "no"/"off"/"" must not enable anything — the failure mode that matters.
    for (const falsy of ["0", "no", "off", "", "FALSE", "banana"]) {
      assert.equal(loadEnv(envWith({ COVE_LIVE_ENABLED: falsy })).liveEnabled, false, falsy);
    }
  });

  it("defaults to off when unset", () => {
    const env = loadEnv(envWith());
    assert.equal(env.liveEnabled, false);
    assert.equal(env.federationEnabled, false);
    assert.equal(env.federationAllowReplies, false);
  });
});

describe("required configuration", () => {
  it("rejects a missing site URL with an actionable message", () => {
    assert.throws(
      () => loadEnv({ ...BASE, COVE_SITE_URL: undefined }),
      // The message must tell the operator what to do, not just what broke.
      envErrorMatching(/COVE_SITE_URL[\s\S]*setup\.sh/),
    );
  });

  it("rejects a non-http site URL", () => {
    assert.throws(() => loadEnv(envWith({ COVE_SITE_URL: "cove.example.com" })), EnvError);
  });

  it("rejects an invalid handle", () => {
    for (const bad of ["has space", "-leading", "trailing_", "way-too-long-handle-name-here"]) {
      assert.throws(() => loadEnv(envWith({ COVE_HANDLE: bad })), EnvError, bad);
    }
  });
});

describe("site URL normalisation", () => {
  it("strips trailing slashes so URIs cannot end up doubled", () => {
    assert.equal(loadEnv(envWith({ COVE_SITE_URL: "https://cove.example.com/" })).siteUrl, "https://cove.example.com");
    assert.equal(loadEnv(envWith({ COVE_SITE_URL: "https://cove.example.com///" })).siteUrl, "https://cove.example.com");
  });

  it("keeps a non-default port, which LAN installs depend on", () => {
    assert.equal(loadEnv(envWith({ COVE_SITE_URL: "http://localhost:8080" })).siteUrl, "http://localhost:8080");
  });
});

describe("secrets", () => {
  it("refuses to start in production without a real session secret", () => {
    assert.throws(
      () => loadEnv(envWith({ NODE_ENV: "production", COVE_SESSION_SECRET: "too-short" })),
      envErrorMatching(/COVE_SESSION_SECRET/),
    );
  });

  it("allows a development fallback so `pnpm dev` needs no .env", () => {
    const env = loadEnv({ ...BASE, NODE_ENV: "development", COVE_SESSION_SECRET: undefined });
    assert.equal(isUsingDevSecret(env), true);
  });

  it("reports a production environment as production", () => {
    const env = loadEnv(envWith({ NODE_ENV: "production" }));
    assert.equal(env.isProduction, true);
    assert.equal(isUsingDevSecret(env), false);
  });
});

describe("numeric coercion still works", () => {
  it("parses worker concurrency and clamps out-of-range values", () => {
    assert.equal(loadEnv(envWith({ WORKER_CONCURRENCY: "4" })).workerConcurrency, 4);
    assert.throws(() => loadEnv(envWith({ WORKER_CONCURRENCY: "0" })), EnvError);
    assert.throws(() => loadEnv(envWith({ WORKER_CONCURRENCY: "999" })), EnvError);
  });
});
