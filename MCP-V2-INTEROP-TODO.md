# qyl.mcp ChatGPT and MCP v2 interoperability

Work toward one production endpoint, `https://mcp.qyl.at/mcp`, supporting MCP
revision `2026-07-28` and OAuth 2.1. Never add an MCP 2025 protocol fallback.

## Completed locally

- [x] Keep the server pinned to MCP revision `2026-07-28`; reject `2025-06-18`
  with `-32022`.
- [x] Validate the Auth0 issuer metadata for CIMD, DCR, authorization code,
  PKCE S256, issuer identification, and supported client authentication.
- [x] Serve both RFC 9728 protected-resource metadata paths with canonical
  resource `https://mcp.qyl.at/mcp`; retain `qyl:read` in the 401 challenge.
- [x] Verify RFC 9068 RS256 access tokens for issuer, audience, expiry, subject,
  client ID, token ID, and scope.
- [x] Declare `qyl:read` in `_meta.securitySchemes` on all 11 tools and preserve
  read-only annotations in the regenerated tool snapshot.
- [x] Document the Auth0 setup, exact client metadata URLs, callbacks, and local
  v2 client commands in `README.md`.
- [x] Pass the repository test command and local modern-protocol checks with
  Claude Code, Codex CLI, and MCP Inspector.

- [x] Mark `display_traces` (global and thread) and `display_mcp_dashboard`
  (global) as ChatGPT plugin-extension entry points, with a monochrome
  entry-point icon and `inline`/`fullscreen` display modes on both viewers.
- [x] Serve MCP Events (`trace.error`, webhook delivery with callback
  verification and Standard Webhooks signatures) when `MCP_EVENTS_STORE` is set;
  declare the `/data` volume and the store path in `.railway/railway.ts`.
- [x] Answer `/.well-known/openai-apps-challenge` with `OPENAI_APPS_CHALLENGE`.

## Production work — requires the user's go

- [ ] Push commit `f228614` and deploy qyl.mcp. Confirm the production root and
  path-suffixed protected-resource documents both return the same canonical
  resource and `qyl:read` scope.
- [ ] In Auth0, set the API identifier to `https://mcp.qyl.at/mcp`, enable the
  RFC 9068 access-token profile and RS256, and define the `qyl:read` permission.
- [ ] Enable CIMD, the Resource Parameter Compatibility Profile, and issuer
  identification. Keep PKCE S256 available.
- [ ] Import these CIMD documents and preserve their published redirects and
  token methods:
  - ChatGPT: `https://chatgpt.com/oauth/client.json`
  - claude.ai: `https://claude.ai/oauth/mcp-oauth-client-metadata`
  - Claude Code: `https://claude.ai/oauth/claude-code-client-metadata`
- [ ] Enable DCR in strict mode. Keep third-party API default permissions empty;
  create explicit `qyl:read` grants for the intended test clients and users.
- [ ] Confirm Auth0 issues a token whose audience contains the exact resource
  identifier accepted by the server and whose scope contains `qyl:read`.
- [ ] Complete one real login and one successful read-tool call through CIMD and
  DCR, covering ChatGPT, Claude, and a generic OAuth MCP client. If a ChatGPT
  surface requests the legacy MCP protocol, stop that client test and do not add
  a v1 server path.
- [ ] Connect ChatGPT web, claude.ai, Claude Code, Codex CLI, and MCP Inspector;
  list tools and call one read tool in each. Record each client version,
  registration path, consented scopes, tool result, and any exact error in the
  README.

- [ ] Merge the ChatGPT plugin branch; `railway-config` applies the new
  volume and `MCP_EVENTS_STORE`. Confirm `server/discover` on
  `https://mcp.qyl.at/mcp` lists `events`.
- [ ] In the OpenAI plugin portal choose **Create plugin → With MCP** with
  `https://mcp.qyl.at/mcp`; set `OPENAI_APPS_CHALLENGE` in Railway to the
  portal's token and complete domain verification. Enable the `openid` and
  `email` scopes with a verified-email UserInfo response for workspace domain
  restrictions.
- [ ] In ChatGPT, subscribe to `trace.error` for one service, produce an error
  trace, and confirm the signed delivery reaches the chat; then stop
  monitoring and confirm `events/unsubscribe`.

## Auth0 discovery decision

Auth0 is the authorization server and already serves OIDC discovery at
`https://qyl-eu.eu.auth0.com/.well-known/openid-configuration`. qyl.mcp does not
serve `/.well-known/openid-configuration` on `mcp.qyl.at`, because qyl.mcp is a
resource server rather than the token issuer. If ChatGPT workspace domain
claiming is needed, enable `openid` and `email` for the OAuth client and verify
that Auth0 UserInfo returns a verified email; this does not replace the
resource permission `qyl:read`.
