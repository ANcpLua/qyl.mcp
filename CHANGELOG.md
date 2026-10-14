# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 8.1.1

- Package the corrected qyl-investigate skill: `verify_fix` needs `since` or `release` beside the `failure_id`.
- Documentation only otherwise: the plugin bundle README, the Anthropic listing draft and both plugin manifests describe the 32-tool surface; the release contract records the OpenAI plugin draft and the verified domain; the threat model states the single scope check. No code change since 8.1.0.

## 8.1.0

- Serve the qyl-investigate skill from the server through the MCP skills extension (`io.modelcontextprotocol/skills`: `skills/list`, `skills/get` and `resources/read` under `skill://qyl/`), so the OpenAI plugin portal imports it at Scan Tools and the npm package carries it in `dist/skills`. The skill now names the tool to start with for each question, the defaults every tool applies, the accepted `aggregate_telemetry` measures, and the one-call connection rule: no fan-out before one call has returned telemetry, one retry after sign-in, then stop.
- Advertise output schemas inlined rather than hoisted into `$defs`: ChatGPT does not resolve `$ref`, so `verify_fix.verdict` and most of `get_failure_context` reached the model as `unknown`. The redundant date-time regex is dropped from advertised schemas.
- Use collector contract 12.1.2, whose tool descriptions state the default window, baseline, page sizes, span selection and the accepted measure and ordering values.

## 8.0.0

- The executable now requires Bun 1.4 or later, including stdio. Library subpaths remain usable on Node 24; TypeScript 7 continues to emit the package.
- Start HTTP explicitly with a 60-second idle timeout so quiet SSE responses survive the SDK keep-alive. Stop the HTTP server during shutdown.
- Request read, write and delete scopes at initial sign-in; step-up challenges name only missing scopes.
- Return useful text summaries, bounded evidence and continuations; validate failure updates and make create retries idempotent by default.
- Use collector contract 12.1.1 for corrected analysis paging, coverage and failure timestamps. Remove the obsolete demo runtime and duplicate read implementations.
- Pin SemanticConventions 9.9.1, including the canonical `qyl.gen_ai.tool.call.arguments_hash` definition used by collector 12.1.1 for repeated-call analysis.
- Preserve note drafts, render trace drill-down results and use consistent dashboard filters. Gate the real OTLP answer-key and Bun quiet-stream regressions.
