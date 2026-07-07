---
name: qyl
description: Read-only qyl observability — query the qyl collector for traces,
  spans, sessions (incl. GenAI token usage/cost), and logs. Use when the user
  asks what's failing, what's slow, what a trace/session contains, or wants
  log search against qyl, without opening the dashboard. Read-only; never
  ingests or mutates telemetry.
---

# qyl (Read-only Observability)

## Quick start

1. The qyl collector read API is **unauthenticated** today (only OTLP *ingest*
   takes an API key), so no token is required. If `QYL_AUTH_TOKEN` is set it is
   sent as a Bearer header for forward-compatibility — never echo it, and never
   ask the user to paste a token into chat; ask them to set the env var locally
   and confirm when ready.
2. Optional: `QYL_BASE_URL` (default `http://127.0.0.1:5100`).
3. Defaults: time range **24h**, limit **20** (max 50), newest first.
4. Always call the qyl API via the bundled script (no heuristics, no caching).
5. If the collector is unreachable, tell the user to start it:
   `dotnet run --project services/qyl.collector` (local dev:
   `QYL_OTLP_AUTH_MODE=Unsecured`).

## Core tasks (use bundled script)

`scripts/qyl_api.py` (relative to this SKILL.md) makes deterministic GET-only
calls: it drains cursor pagination, retries once on transient errors, redacts
PII (emails, IPv4) in log bodies, and truncates log bodies to their first line
unless `--show-stacktraces`.

```bash
export QYL_API="<dir-of-this-skill>/scripts/qyl_api.py"
```

### 1) List recent traces (newest first)

```bash
python3 "$QYL_API" --time-range 24h --limit 20 list-traces
python3 "$QYL_API" list-traces --errors-only          # failing traces only
python3 "$QYL_API" list-traces --service qyl-collector
```

### 2) Trace detail (summary + error spans; use the full trace_id from list-traces)

```bash
python3 "$QYL_API" trace-detail <trace_id>
```

### 3) Spans of a trace

```bash
python3 "$QYL_API" trace-spans <trace_id>
```

### 4) Sessions (incl. GenAI usage / estimated cost)

```bash
python3 "$QYL_API" --time-range 7d list-sessions
python3 "$QYL_API" list-sessions --active-only
python3 "$QYL_API" session-traces <session.id>
```

### 5) Log search

```bash
python3 "$QYL_API" search-logs --severity-min 17            # ERROR and up
python3 "$QYL_API" search-logs --trace-id <trace_id>        # logs of one trace
python3 "$QYL_API" search-logs --service checkout-api --query timeout
```

Add `--json` to any command for the raw API payload.

## API requirements

GET-only against the collector under `/api/v1` (snake_case bodies, camelCase
query params):

- List traces: `/api/v1/traces` (single-shot; script filters by time client-side)
- Trace detail: `/api/v1/traces/{trace_id}`
- Trace spans: `/api/v1/traces/{trace_id}/spans`
- List sessions: `/api/v1/sessions?startTime=&isActive=&limit=&cursor=`
- Session traces: `/api/v1/sessions/{session_id}/traces`
- Logs: `/api/v1/logs?traceId=&serviceName=&severityMin=&query=&startTime=&limit=`

Do NOT call `/issues`, `/errors`, `/services`, `/metrics` — the standalone
collector does not serve them (they return 404).

## Inputs and defaults

- `time_range`: default `24h` (`30m`/`24h`/`7d` style).
- `limit`: default 20, max 50 (script paginates cursored endpoints until reached).
- `severity_min`: OTel numbers — 9 INFO, 13 WARN, 17 ERROR, 21 FATAL.
- Identifiers: `trace_id` = 32 hex chars, `span_id` = 16 hex chars,
  `session.id` from list-sessions. There are no short IDs or org/project slugs
  in qyl — the collector is single-tenant.

## Output formatting rules

- Trace list: root span name, short trace id, error flag, span count,
  humanized duration, services, start time; newest first.
- Trace detail: root span, duration, spans-per-service, error spans with
  status messages (redacted, truncated) — never raw stack traces unless the
  user explicitly asks (`--show-stacktraces`).
- Sessions: state, trace/span/error counts, services, GenAI estimated cost
  when present.
- If no results, state that explicitly (the script already does).
- Redact PII (emails, IPs) in anything quoted from log bodies. Never echo
  auth tokens.

## Golden test

With the collector running and any MCP traffic through mcp-run:
"List failing traces from the last 24h and show the error in the newest one."
Expected: `list-traces --errors-only` table, then `trace-detail <id>` showing
the error span with its status message.

## Known gaps (v2 when the collector grows them)

Issue grouping (`/issues`), error stats, service catalog, and metrics were
part of the deleted `services/qyl.mcp` surface and are not served by today's
collector — do not fake them from trace data unless the user asks for a
best-effort approximation and you label it as such.
