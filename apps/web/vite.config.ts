import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
    port: 5173,
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
});
