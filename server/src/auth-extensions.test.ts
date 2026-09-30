import assert from "node:assert/strict";
import test from "node:test";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import {
  authorizationExtensions,
  clientCredentialsAuthorization,
  enterpriseManagedAuthorization,
  readAuthorizationExtensions,
  resolveAuthorizationExtensions,
  validateAuthorizationExtensions,
  type AuthorizationExtension,
} from "./auth-extensions.js";

const metadata: OAuthMetadata = {
  issuer: "https://issuer.example/",
  authorization_endpoint: "https://issuer.example/authorize",
  token_endpoint: "https://issuer.example/token",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "client_credentials", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
  token_endpoint_auth_methods_supported: ["private_key_jwt"],
  authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
};

test("extensions are optional, version-pinned and composable in either order", () => {
  assert.deepEqual(readAuthorizationExtensions({}), []);
  assert.deepEqual(readAuthorizationExtensions({ MCP_AUTH_EXTENSIONS: " " }), []);
  const before = structuredClone(metadata);
  const selections = authorizationExtensions.map((extension) => `${extension.id}@${extension.version}`);
  for (const selected of [[], selections, [...selections].reverse()]) {
    const resolved = resolveAuthorizationExtensions(selected);
    validateAuthorizationExtensions(metadata, resolved);
    assert.deepEqual(metadata, before, "extensions must never rewrite AS capabilities");
  }
  for (const extension of authorizationExtensions) {
    validateAuthorizationExtensions(metadata, [extension]);
  }
});

test("unknown, unpinned, conflicting and duplicate versions fail closed", () => {
  for (const selection of ["oauth-client-credentials", "oauth-client-credentials@latest",
    "oauth-client-credentials@2.0.0", "unknown@1.0.0", ""]) {
    assert.throws(() => resolveAuthorizationExtensions([selection]), /Unknown authorization extension/u);
  }
  assert.throws(() => resolveAuthorizationExtensions([
    "oauth-client-credentials@1.0.0", "oauth-client-credentials@1.0.0",
  ]), /Duplicate/u);
  assert.throws(() => validateAuthorizationExtensions(metadata, [
    clientCredentialsAuthorization, { ...clientCredentialsAuthorization, version: "2.0.0" },
  ]), /Duplicate/u);
  assert.throws(() => readAuthorizationExtensions({ MCP_AUTH_EXTENSIONS: "oauth-client-credentials@1.0.0," }), /Unknown/u);
  assert.throws(() => resolveAuthorizationExtensions(["oauth-client-credentials@1.0.0"], [
    clientCredentialsAuthorization, { ...clientCredentialsAuthorization, requirements: {} },
  ]), /Ambiguous/u);
});

test("only selected extensions require their provider grants", () => {
  const coreOnly = { ...metadata, grant_types_supported: ["authorization_code"] };
  validateAuthorizationExtensions(coreOnly, []);
  for (const extension of authorizationExtensions) {
    assert.throws(() => validateAuthorizationExtensions(coreOnly, [extension]), /extension requirement/u);
  }
  assert.throws(() => validateAuthorizationExtensions({
    ...metadata, authorization_grant_profiles_supported: [],
  }, [enterpriseManagedAuthorization]), /authorization_grant_profiles_supported/u);
  assert.throws(() => validateAuthorizationExtensions({
    ...metadata, token_endpoint_auth_methods_supported: ["none"],
  }, [clientCredentialsAuthorization]), /token_endpoint_auth_methods_supported/u);
});

test("new modules compose without changing the core or sharing a protocol revision", () => {
  const additional: AuthorizationExtension = {
    id: "example-extension", version: "3.2.1", stability: "draft",
    specification: "https://example.com/extension",
    requirements: { example_capability: true, grant_types_supported: ["example_grant"] },
  };
  const selected = resolveAuthorizationExtensions([
    "example-extension@3.2.1", "oauth-client-credentials@1.0.0",
  ], [...authorizationExtensions, additional]);
  validateAuthorizationExtensions({
    ...metadata, example_capability: true,
    grant_types_supported: [...metadata.grant_types_supported!, "example_grant"],
  }, selected);
  assert.throws(() => validateAuthorizationExtensions(metadata, selected), /extension requirement/u);
  assert.throws(() => validateAuthorizationExtensions(metadata, [additional, {
    ...additional, id: "conflicting-extension", requirements: { example_capability: ["value"] },
  }]), /Conflicting/u);
});
