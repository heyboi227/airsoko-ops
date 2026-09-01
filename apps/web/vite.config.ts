import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The repository root holds the single .env; every workspace reads that one
// file rather than keeping its own copy to drift out of sync. Pointing
// `envDir` there is what lets VITE_API_URL and VITE_MAP_TILE_URL reach the
// browser bundle from the same file the API reads.
const envDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  // An empty prefix loads unprefixed values as well, so WEB_PORT is visible
  // to this config. Only VITE_-prefixed values are ever handed to the client.
  const env = loadEnv(mode, envDir, "");
  const port = Number.parseInt(env.WEB_PORT ?? "", 10) || 5273;

  return {
    plugins: [react()],
    envDir,
    resolve: {
      alias: [
        {
          // Point at the ESM build explicitly. MapLibre ships both a CJS
          // `maplibre-gl.js` and an ESM `maplibre-gl.mjs`; with the package
          // excluded from pre-bundling below, Vite resolves the bare specifier
          // to the CJS file, which has no named exports and fails at import.
          //
          // Anchored, because a plain string alias is a prefix match and would
          // also rewrite `maplibre-gl/dist/maplibre-gl.css` into a path inside
          // the .mjs file.
          find: /^maplibre-gl$/,
          replacement: "maplibre-gl/dist/maplibre-gl.mjs",
        },
      ],
    },
    server: {
      // Deliberately not Vite's default 5173, which is busy often enough on a
      // developer machine that the strict port below would refuse to start.
      // Override with WEB_PORT in .env.
      port,
      strictPort: true,
    },
    optimizeDeps: {
      // Workspace packages are consumed as TypeScript source rather than built
      // output, so a change in the kernel shows up here without a build step.
      // Excluding them from pre-bundling is what keeps that true.
      // MapLibre ships its renderer in a Web Worker. Vite's dependency
      // pre-bundler rewrites the import and the worker then fails to load
      // (ERR_FAILED on maplibre-gl-worker.mjs), which leaves every GeoJSON
      // source stuck at loaded: false. The background layer still paints, so the
      // map looks alive while nothing on it renders -- a genuinely confusing
      // failure that cost most of the Phase 1 spike to find.
      exclude: ["@airsoko/contracts", "@airsoko/domain", "maplibre-gl"],
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
