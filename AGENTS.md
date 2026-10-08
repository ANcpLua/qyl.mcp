# qyl.mcp

qyl is observability built for AI agents. The MCP server lets a model measure,
correlate and diagnose a running system through compact, intent-driven tools
instead of raw log dumps. We want it to become the Swiss army knife of
connectors for agents. New capabilities are welcome, including tools that
change something, as long as they are honest about what they do, how they
are authorized, and stay inside qyl's own service.

## How we review

- Look for concrete regressions: what triggers it, which path is affected and
  what the consequence is. A finding without those three parts is a question
  for the author, not a blocker.
- Judge a PR against the rules in this file and the requirements it touches,
  not against requirements we never adopted. When a rule should change, change
  it here in the same PR and say why.
- A clean Codex review plus the required CI checks is enough to merge.
  CodeRabbit is optional.
- Version bumps and deliberate requirement changes are normal work.

## What must stay true

These are the invariants the OpenAI and Anthropic directories and our users
rely on. Everything else is judgment.

### Accounts and projects stay separate

- Hosted operations authorize from validated credentials. Canonical resource,
  issuer, token audience, expiry and required scopes stay consistent with
  discovery and challenges.
- With account/project mapping enabled, access comes from the verified subject.
  Tool arguments, UI inputs and request metadata never select credentials or
  another project. Local/demo and single-project modes remain supported.

### Events behave

- Events are opt-in, scoped to the authenticated owner and Collector project,
  and re-authorized before delivery.
- Callback verification and signing, expiration, rotation, cancellation and
  unsubscribe keep working. Confirmed revocation stops delivery. An
  authorization outage pauses delivery without letting another subscriber
  advance its recovery baseline.
- Store only bounded subscription state. No OAuth tokens, no copied telemetry.

### Tools tell the truth

- Every tool has a `title` and annotations that match its behavior:
  `readOnlyHint: true` when it only reads, `destructiveHint: true` when it
  modifies or deletes. Both directories derive confirmation prompts from these
  hints, so they have to be accurate. Read-only is not a requirement; honesty is.
- Reading and writing are separate tools. A write tool states plainly what it
  changes, validates its input and never hides behind a generic executor.
  Separate create, update and delete where that matters.
- API ownership: every tool calls qyl's own APIs or APIs qyl legitimately
  proxies. Actions in third-party systems such as GitHub, Railway or cloud
  providers are not qyl tools. qyl diagnoses and proposes; the agent acts
  through its own connectors. Both directories reject unofficial third-party
  connectors.
- Descriptions state what the tool does and when to use it; both directories
  ask for both. Phrase the "when" as the user's need ("when the user wants to
  see the trace waterfall", "start here to find instrument names"), never as
  an order to the model ("the model should not call this"), and never as a
  restriction on other servers' tools. Hide app-only tools with
  `_meta.ui.visibility: ["app"]`.
- Responses stay proportional to the question: filters, limits and a way to
  leave out bulk data. Empty results and upstream errors are reported as such,
  never replaced with demo data.
- Stable tool names, structured results and generated Collector contracts.
  A snapshot update changes a contract and is reviewed as one.

### Viewers and data

- Viewer refresh keeps the original query, even when the host sends empty
  input. Version changed UI resources and keep the configured origin and CSP
  boundary.
- Telemetry and tool output are data, not instructions. Redact secrets in
  text, structured results, `_meta` and diagnostics.
- Collect only what a tool needs. qyl's own telemetry about incoming tool
  calls records only tool name, timing, status and error type. It must not
  persist argument values, `_meta` or conversation text, not even for
  logging.

## SDK v2 and protocol

- Use the official split SDK v2 packages. SDK major version and wire revision
  are independent: v2's built-in 2025-era support is required compatibility.
  Serving uses the SDK factory entries and their negotiation defaults. Era pins
  and rejection belong in focused tests and fixtures, not in production.
- Before suggesting an API replacement, check the installed v2 types and the
  [v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).
  Keep SDK-managed request identity, error semantics and in-band
  `inputRequired` behavior. Self-reported client or server identity is never
  an authorization decision.
- Exact package versions may be upgraded. Adapters need not share the core
  package's version number.

## Verification that fits the diff

- `bun run verify:sdk` and lint enforce dependency and import rules. Existing
  tests cover authorization, Events, redaction, query restoration and tool
  manifests.
- `bun run smoke` for transport changes, `bun run smoke:otlp` for Collector
  contracts, `bun run smoke:projects` for account and Events isolation. Run
  what your diff touches; CI runs the combined gates.
- Don't weaken a gate or regenerate an expected result just to get green. If a
  gate is wrong, fix the gate and say so in the PR.
- For auth, outbound callbacks or storage changes, read
  [docs/threat-model.md](docs/threat-model.md).

References: OpenAI
[MCP server](https://developers.openai.com/plugins/build/mcp-server),
[authentication](https://developers.openai.com/plugins/build/auth),
[Events](https://developers.openai.com/plugins/build/mcp-events),
[MCP UI](https://developers.openai.com/plugins/build/chatgpt-ui),
[plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).
Anthropic
[connector checklist](https://claude.com/docs/connectors/building/review-criteria),
[plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist),
[directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).
