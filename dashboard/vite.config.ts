import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two build targets, same INPUT-env pattern as ext-apps basic-host:
//   INPUT=index.html   → dist/         (the dashboard app)
//   INPUT=sandbox.html → dist-sandbox/ (self-contained sandbox proxy the runner
//                                       serves from the separate :18889 origin)
// The sandbox build inlines everything via viteSingleFile so the runner only
// ever serves a single file, with CSP response headers derived from ?csp=.
const input = process.env.INPUT ?? "index.html";
const isSandbox = input === "sandbox.html";

export default defineConfig({
  plugins: isSandbox ? [viteSingleFile()] : [react()],
  server: {
    proxy: {
      "/runner": { target: "http://127.0.0.1:18888", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: { input },
    outDir: isSandbox ? "dist-sandbox" : "dist",
    emptyOutDir: true,
    // The sandbox is a single inlined file with no further imports — don't let
    // vite inject the module preload polyfill into it.
    modulePreload: isSandbox ? { polyfill: false } : undefined,
  },
});
