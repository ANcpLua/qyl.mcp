import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Four single-file builds into dist/, selected by --mode:
//   vite build --mode mcp-home       → dist/mcp-home.html      (public entry)
//   vite build --mode mcp-app        → dist/mcp-app.html       (trace explorer)
//   vite build --mode mcp-dashboard  → dist/mcp-dashboard.html (MCP dashboard)
//   vite build --mode observe-graph  → dist/observe-graph.html  (workflow debugger)
// The compiled server (tsc -p tsconfig.server.json) lands in the same dist/
// and reads the viewer HTML from there — hence emptyOutDir: false.
export default defineConfig(({ mode }) => {
  const input =
    mode === "mcp-home"
      ? "mcp-home.html"
      : mode === "observe-graph"
        ? "observe-graph.html"
      : mode === "mcp-dashboard"
        ? "mcp-dashboard.html"
        : "mcp-app.html";
  return {
    plugins: [viteSingleFile()],
    build: {
      rollupOptions: { input },
      outDir: "dist",
      emptyOutDir: false,
    },
  };
});
