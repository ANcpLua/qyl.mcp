import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/runner": { target: "http://127.0.0.1:18888", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: { input: "index.html" },
    outDir: "dist",
    emptyOutDir: true,
  },
});
