import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // Inline data: fonts would be blocked by the server CSP (font-src self).
    assetsInlineLimit: 0,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
});
