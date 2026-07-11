import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two build targets, selected by --mode:
//   vite build                → dist/         (the dashboard app)
//   vite build --mode sandbox → dist-sandbox/ (self-contained sandbox proxy the
//                               runner serves from the separate :18889 origin)
// The sandbox build inlines everything via viteSingleFile so the runner only
// ever serves a single file, with CSP response headers derived from ?csp=.
export default defineConfig(({ mode }) => {
  const isSandbox = mode === "sandbox";
  return {
    plugins: isSandbox ? [viteSingleFile()] : [react()],
    server: {
      proxy: {
        "/runner": { target: "http://127.0.0.1:18888", changeOrigin: true },
      },
    },
    build: {
      rollupOptions: { input: isSandbox ? "sandbox.html" : "index.html" },
      outDir: isSandbox ? "dist-sandbox" : "dist",
      emptyOutDir: true,
      // The sandbox is a single inlined file with no further imports — don't let
      // vite inject the module preload polyfill into it.
      modulePreload: isSandbox ? { polyfill: false } : undefined,
    },
  };
});
