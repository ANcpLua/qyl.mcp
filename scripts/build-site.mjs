import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const outputRoot = new URL("../dist/", import.meta.url);
const workerOutput = new URL("server/index.js", outputRoot);
const hostingOutput = new URL(".openai/hosting.json", outputRoot);
const landingPage = await readFile(
  new URL("server/dist/mcp-home.html", projectRoot),
  "utf8",
);

const worker = `const landingPage = ${JSON.stringify(landingPage)};

const htmlHeaders = {
  "Cache-Control": "public, max-age=300",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
};

export default {
  fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const pathname = new URL(request.url).pathname;
    if (pathname !== "/" && pathname !== "/index.html") {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(request.method === "HEAD" ? null : landingPage, {
      headers: htmlHeaders,
    });
  },
};
`;

await rm(outputRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(new URL("server/", outputRoot), { recursive: true }),
  mkdir(new URL(".openai/", outputRoot), { recursive: true }),
]);
await Promise.all([
  writeFile(workerOutput, worker, "utf8"),
  copyFile(new URL(".openai/hosting.json", projectRoot), hostingOutput),
]);
