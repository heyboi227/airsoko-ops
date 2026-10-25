import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The repository root holds the single .env; every workspace reads that one
// file rather than keeping its own copy to drift out of sync. Pointing
// `envDir` there is what lets VITE_API_URL and VITE_MAP_TILE_URL reach the
// browser bundle from the same file the API reads.
const envDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Every chunk the build writes is held to 500 kB except MapLibre's: it is one
// module of about 1,070 kB that cannot be divided, and it is only fetched when
// /live opens. Vite's own advisory takes a single limit for the whole build, so
// that limit is set above MapLibre below and this check holds everything else to
// the budget (decision 38).
const CHUNK_BUDGET_KB = 500;

function chunkBudget(): Plugin {
  return {
    name: "airsoko:chunk-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || output.name === "maplibre") continue;
        const kb = output.code.length / 1000;
        if (kb > CHUNK_BUDGET_KB)
          this.warn(
            `${output.fileName} is ${Math.round(kb)} kB, over the ${CHUNK_BUDGET_KB} kB chunk budget`,
          );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // An empty prefix loads unprefixed values as well, so WEB_PORT is visible
  // to this config. Only VITE_-prefixed values are ever handed to the client.
  const env = loadEnv(mode, envDir, "");
  const port = Number.parseInt(env.WEB_PORT ?? "", 10) || 5273;

  return {
    plugins: [react(), chunkBudget()],
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
      // Only MapLibre's chunk (1,066 kB) answers to this limit now, with room for
      // its releases to grow; chunkBudget() holds every other chunk to 500 kB.
      chunkSizeWarningLimit: 1500,
      rolldownOptions: {
        output: {
          // Vendor code is grouped by who needs it and how often it changes. React
          // and MUI are needed on every page; MUI's styling layer is shared with the
          // dashboard's charts; MapLibre travels alone, so a change to the live page
          // does not invalidate a megabyte of it in the browser's cache.
          //
          // A group also takes in whatever its modules import, so the priorities
          // decide who claims shared code: React first, then MUI's styling layer,
          // then MUI's components. With equal priorities the components' group
          // swallowed the styling layer and came to 559 kB.
          codeSplitting: {
            groups: [
              {
                name: "maplibre",
                test: /[\\/]node_modules[\\/]maplibre-gl[\\/]/,
                priority: 40,
              },
              {
                name: "react",
                test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 30,
              },
              {
                name: "mui-system",
                test: /[\\/]node_modules[\\/](@mui[\\/](system|utils|styled-engine|private-theming)|@emotion|@popperjs|react-transition-group)[\\/]/,
                priority: 25,
              },
              {
                name: "mui",
                test: /[\\/]node_modules[\\/]@mui[\\/]material[\\/]/,
                priority: 20,
              },
            ],
          },
        },
      },
    },
  };
});
