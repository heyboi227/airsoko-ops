import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    // Workspace packages are consumed as TypeScript source rather than built
    // output, so a change in the kernel shows up here without a build step.
    // Excluding them from pre-bundling is what keeps that true.
    exclude: ["@airsoko/contracts", "@airsoko/domain"],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
