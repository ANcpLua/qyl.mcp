import assert from "node:assert/strict";
import test from "node:test";
import { checkLock, checkManifest } from "./verify-mcp-sdk.mjs";

test("v2 SDK adapters can have independent exact versions; extensions have their own versions", () => {
  assert.deepEqual(checkManifest({ dependencies: {
    "@modelcontextprotocol/server": "2.3.1",
    "@modelcontextprotocol/node": "2.1.1",
    "@modelcontextprotocol/ext-apps": "1.4.0",
  } }), []);
});

test("v1 SDK cannot enter through any dependency section or an npm alias", () => {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.match(checkManifest({ [section]: { "@modelcontextprotocol/sdk": "1.26.0" } })[0], /SDK v1/u);
    assert.match(checkManifest({ [section]: { hidden: "npm:@modelcontextprotocol/sdk@1.26.0" } })[0], /SDK v1/u);
  }
});

test("ranges, tags, git URLs and other SDK majors fail the exact-v2 contract", () => {
  for (const version of ["^2.3.1", "~2.3.1", "latest", "next", "1.26.0", "3.0.0", "github:modelcontextprotocol/typescript-sdk"]) {
    assert.match(checkManifest({ dependencies: { "@modelcontextprotocol/server": version } })[0], /exact v2/u);
  }
  assert.match(checkManifest({ dependencies: { alias: "npm:@modelcontextprotocol/client@^2.3.1" } })[0], /exact v2/u);
});

test("transitive v1 and alias resolutions in Bun lockfiles fail even with clean manifests", () => {
  assert.match(checkLock({ workspaces: { "": {} }, packages: {
    hidden: ["@modelcontextprotocol/sdk@1.26.0", "", {}],
  } })[0], /SDK v1/u);
  assert.match(checkLock({ workspaces: {}, packages: {
    "nested/@modelcontextprotocol/core": ["@modelcontextprotocol/core@1.0.0", "", {}],
  } })[0], /exact v2/u);
});

test("transitive SDK peer ranges are valid once the actual resolved packages are v2", () => {
  assert.deepEqual(checkLock({ workspaces: {}, packages: {
    "@modelcontextprotocol/express": ["@modelcontextprotocol/express@2.0.2", "", {
      peerDependencies: { "@modelcontextprotocol/server": "^2.3.0" },
    }],
    "@modelcontextprotocol/server": ["@modelcontextprotocol/server@2.3.1", "", {}],
  } }), []);
  assert.throws(() => checkLock({}), /unsupported Bun lockfile shape/u);
});
