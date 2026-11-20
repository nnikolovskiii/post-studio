import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The editor is served by the Fastify server (apps/server) from dist/ on 127.0.0.1:3472.
// Static files go under /static so they never collide with /v1 or the /p/:id routes.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  base: "/",
  plugins: [react()],
  logLevel: "error",
  build: {
    target: "es2022",
    outDir: "dist",
    assetsDir: "static",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    reportCompressedSize: false,
    rollupOptions: {
      onwarn(w, warn) {
        // zod's comments and harfbuzzjs's Node-only `import("module")` branch are harmless here.
        if (w.code === "INVALID_ANNOTATION" || /externalized for browser compatibility/.test(w.message)) return;
        warn(w);
      },
    },
  },
  server: { proxy: { "/v1": "http://127.0.0.1:3472" } },
});
