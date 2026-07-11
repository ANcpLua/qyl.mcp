import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two single-file viewer builds into dist/, selected by --mode:
//   vite build --mode mcp-app        → dist/mcp-app.html       (trace explorer)
//   vite build --mode mcp-dashboard  → dist/mcp-dashboard.html (MCP dashboard)
// The compiled server (tsc -p tsconfig.server.json) lands in the same dist/
// and reads the viewer HTML from there — hence emptyOutDir: false.
export default defineConfig(({ mode }) => {
  const input =
    mode === "mcp-dashboard" ? "mcp-dashboard.html" : "mcp-app.html";
  return {
    plugins: [viteSingleFile()],
    build: {
      rollupOptions: { input },
      outDir: "dist",
      emptyOutDir: false,
    },
  };
});
