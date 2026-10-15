import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone emits a self-contained server bundle, which is what the Docker
  // image runs. In a pnpm workspace it preserves the monorepo layout, so the
  // entrypoint ends up at apps/web/server.js inside the image.
  output: "standalone",

  reactStrictMode: true,

  // The workspace packages ship TypeScript source rather than a build artifact.
  // Next compiles them in place, which keeps the edit-refresh loop instant and
  // removes an entire build-ordering problem from the monorepo.
  transpilePackages: ["@cove/ui", "@cove/shared", "@cove/db"],

  // `pg` must stay external: it resolves optional native bindings and does
  // dynamic requires that a bundler cannot trace reliably.
  serverExternalPackages: ["pg"],

  poweredByHeader: false,

  // Next 16 defaults to Turbopack. We deliberately do not define a `webpack`
  // key anywhere, because a custom webpack config would fail the build unless
  // it is run with --webpack.
  logging: {
    fetches: { fullUrl: true },
  },
};

export default nextConfig;
