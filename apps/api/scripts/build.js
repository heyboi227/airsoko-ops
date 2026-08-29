import { build } from "esbuild";
import { rm } from "node:fs/promises";

/**
 * Production build.
 *
 * esbuild rather than `tsc` because the workspace packages are consumed as
 * TypeScript source: bundling resolves them the same way the dev server does,
 * so what ships is what was tested. Type checking is a separate step
 * (`npm run typecheck`) -- esbuild only strips types, it does not verify them,
 * and CI runs both.
 */

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  minify: false,
  // Native and optional dependencies stay external; bundling them breaks their
  // own runtime resolution.
  packages: "external",
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
