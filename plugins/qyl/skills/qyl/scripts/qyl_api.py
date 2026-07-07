#!/usr/bin/env python3
"""Deterministic read-only client for the qyl collector REST API.

Used by the qyl observability skill. GET-only, stdlib-only. Handles cursor
pagination (sessions/logs), retries once on transient errors, redacts PII
(emails, IPv4) in log bodies unless --no-redact, and never prints stack
traces unless --show-stacktraces.

The collector read API is unauthenticated today (only OTLP ingest takes an
API key). If QYL_AUTH_TOKEN is set it is sent as a Bearer header for
forward-compatibility; it is never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

DEFAULT_BASE_URL = os.environ.get("QYL_BASE_URL", "http://127.0.0.1:5100")
DEFAULT_TIME_RANGE = "24h"
DEFAULT_LIMIT = 20
MAX_LIMIT = 50

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

SEVERITY_NAMES = {
    range(1, 5): "TRACE", range(5, 9): "DEBUG", range(9, 13): "INFO",
    range(13, 17): "WARN", range(17, 21): "ERROR", range(21, 25): "FATAL",
}


def severity_name(number: int, text: str | None) -> str:
    if text:
        return text
    for bucket, name in SEVERITY_NAMES.items():
        if number in bucket:
            return name
    return str(number)


def parse_time_range(value: str) -> timedelta:
    match = re.fullmatch(r"(\d+)([mhd])", value)
    if not match:
        raise SystemExit(f"invalid --time-range '{value}' (use e.g. 30m, 24h, 7d)")
    amount, unit = int(match.group(1)), match.group(2)
    return timedelta(**{{"m": "minutes", "h": "hours", "d": "days"}[unit]: amount})


def redact(text: str, enabled: bool) -> str:
    if not enabled:
        return text
    return IPV4_RE.sub("[ip]", EMAIL_RE.sub("[email]", text))


def humanize_ns(ns: float) -> str:
    if ns >= 1e9:
        return f"{ns / 1e9:.2f} s"
    if ns >= 1e6:
        return f"{ns / 1e6:.0f} ms"
    if ns >= 1e3:
        return f"{ns / 1e3:.0f} µs"
    return f"{ns:.0f} ns"


def iso_from_nano(nano: float) -> str:
    return datetime.fromtimestamp(nano / 1e9, tz=timezone.utc).isoformat(timespec="seconds")


class Api:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.token = os.environ.get("QYL_AUTH_TOKEN")

    def get(self, path: str, params: dict | None = None):
        query = {k: v for k, v in (params or {}).items() if v is not None}
        url = f"{self.base_url}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        request = urllib.request.Request(url, method="GET")
        request.add_header("accept", "application/json")
        if self.token:
            request.add_header("authorization", f"Bearer {self.token}")
        for attempt in (1, 2):
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    return json.loads(response.read())
            except urllib.error.HTTPError as err:
                if err.code >= 500 and attempt == 1:
                    time.sleep(1)
                    continue
                if err.code == 404:
                    return None
                raise SystemExit(f"qyl API error {err.code} for {path}")
            except (urllib.error.URLError, TimeoutError) as err:
                if attempt == 1:
                    time.sleep(1)
                    continue
                raise SystemExit(
                    f"qyl collector unreachable at {self.base_url} ({err}). "
                    "Start it with `dotnet run --project services/qyl.collector` "
                    "or set QYL_BASE_URL."
                )

    def paged(self, path: str, params: dict, limit: int) -> list:
        """Drain CursorPage endpoints until `limit` items are collected."""
        items: list = []
        cursor = None
        while len(items) < limit:
            page = self.get(path, {**params, "cursor": cursor, "limit": min(limit, MAX_LIMIT)})
            if page is None:
                break
            batch = page.get("items", []) if isinstance(page, dict) else page
            items.extend(batch)
            cursor = page.get("next_cursor") if isinstance(page, dict) else None
            if not cursor or not page.get("has_more") or not batch:
                break
        return items[:limit]


def trace_summary_line(trace: dict) -> str:
    root = trace.get("root_span") or (trace.get("spans") or [{}])[0]
    error = "⚠ ERROR" if trace.get("has_error") else "ok"
    return (
        f"{trace.get('trace_id', '')[:16]}…  {root.get('name', '(unnamed)')}  "
        f"[{error}]  spans={trace.get('span_count')}  "
        f"dur={humanize_ns(trace.get('duration_ns', 0))}  "
        f"services={','.join(trace.get('services', []))}  "
        f"start={trace.get('start_time', '')}"
    )


def cutoff_iso(delta: timedelta) -> str:
    return (datetime.now(tz=timezone.utc) - delta).isoformat(timespec="seconds")


def cmd_list_traces(api: Api, args) -> None:
    body = api.get("/api/v1/traces", {"limit": 1000})
    items = (body or {}).get("items", [])
    cutoff = cutoff_iso(parse_time_range(args.time_range))
    items = [t for t in items if t.get("start_time", "") >= cutoff]
    if args.service:
        items = [t for t in items if args.service in t.get("services", [])]
    if args.errors_only:
        items = [t for t in items if t.get("has_error")]
    items.sort(key=lambda t: t.get("start_time", ""), reverse=True)
    items = items[: args.limit]
    if args.json:
        print(json.dumps(items, indent=2))
        return
    if not items:
        print(f"No traces in the last {args.time_range}.")
        return
    print(f"Traces (last {args.time_range}, newest first, {len(items)} shown):")
    for trace in items:
        print("  " + trace_summary_line(trace))


def cmd_trace_detail(api: Api, args) -> None:
    trace = api.get(f"/api/v1/traces/{urllib.parse.quote(args.trace_id)}")
    if trace is None:
        print(f"Trace not found: {args.trace_id}")
        return
    if args.json:
        print(json.dumps(trace, indent=2))
        return
    print(trace_summary_line(trace))
    spans = trace.get("spans", [])
    errors = [s for s in spans if (s.get("status") or {}).get("code") in (2, "error", "Error")]
    services: dict[str, int] = {}
    for span in spans:
        name = str((span.get("resource") or {}).get("service.name", "unknown"))
        services[name] = services.get(name, 0) + 1
    print("  spans per service: " + ", ".join(f"{k}={v}" for k, v in sorted(services.items())))
    if errors:
        print(f"  error spans ({len(errors)}):")
        for span in errors:
            message = (span.get("status") or {}).get("message", "")
            print(f"    - {span.get('name')}  {redact(str(message), not args.no_redact)[:200]}")
    else:
        print("  no error spans.")


def cmd_trace_spans(api: Api, args) -> None:
    body = api.get(f"/api/v1/traces/{urllib.parse.quote(args.trace_id)}/spans")
    items = (body or {}).get("items", []) if isinstance(body, dict) else (body or [])
    if args.json:
        print(json.dumps(items, indent=2))
        return
    if not items:
        print(f"No spans for trace {args.trace_id}.")
        return
    items.sort(key=lambda s: s.get("start_time_unix_nano", 0))
    print(f"Spans for {args.trace_id[:16]}… ({len(items)}):")
    for span in items:
        duration = span.get("end_time_unix_nano", 0) - span.get("start_time_unix_nano", 0)
        status = (span.get("status") or {}).get("code")
        flag = " ⚠" if status in (2, "error", "Error") else ""
        print(f"  {span.get('name')}  {humanize_ns(duration)}{flag}")


def cmd_list_sessions(api: Api, args) -> None:
    params = {"startTime": cutoff_iso(parse_time_range(args.time_range))}
    if args.active_only:
        params["isActive"] = "true"
    items = api.paged("/api/v1/sessions", params, args.limit)
    if args.json:
        print(json.dumps(items, indent=2))
        return
    if not items:
        print(f"No sessions in the last {args.time_range}.")
        return
    items.sort(key=lambda s: s.get("start_time", ""), reverse=True)
    print(f"Sessions (last {args.time_range}, newest first, {len(items)} shown):")
    for session in items:
        genai = session.get("genai_usage") or {}
        cost = genai.get("estimated_cost_usd")
        extra = f"  genai=${cost:.4f}" if isinstance(cost, (int, float)) else ""
        print(
            f"  {session.get('session.id')}  state={session.get('state')}  "
            f"traces={session.get('trace_count')} spans={session.get('span_count')} "
            f"errors={session.get('error_count')}  "
            f"services={','.join(session.get('services', []))}{extra}"
        )


def cmd_session_traces(api: Api, args) -> None:
    body = api.get(f"/api/v1/sessions/{urllib.parse.quote(args.session_id)}/traces")
    if body is None:
        print(f"Session not found: {args.session_id}")
        return
    items = body.get("items", [])[: args.limit]
    if args.json:
        print(json.dumps(items, indent=2))
        return
    if not items:
        print(f"No traces for session {args.session_id}.")
        return
    print(f"Traces for session {args.session_id} ({len(items)}):")
    for trace in items:
        print("  " + trace_summary_line(trace))


def cmd_search_logs(api: Api, args) -> None:
    params = {
        "startTime": cutoff_iso(parse_time_range(args.time_range)),
        "traceId": args.trace_id,
        "serviceName": args.service,
        "severityMin": args.severity_min,
        "query": args.query,
        "limit": args.limit,
    }
    body = api.get("/api/v1/logs", params)
    items = (body or {}).get("items", [])[: args.limit]
    if args.json:
        print(json.dumps(items, indent=2))
        return
    if not items:
        print(f"No logs matched (last {args.time_range}).")
        return
    print(f"Logs (last {args.time_range}, {len(items)} shown):")
    for log in items:
        body_text = str(log.get("body", ""))
        if not args.show_stacktraces:
            body_text = body_text.splitlines()[0] if body_text else ""
        service = (log.get("resource") or {}).get("service.name", "unknown")
        level = severity_name(log.get("severity_number", 0), log.get("severity_text"))
        stamp = iso_from_nano(log.get("time_unix_nano", 0))
        print(f"  {stamp}  {level:<5}  [{service}]  {redact(body_text, not args.no_redact)[:300]}")


def main() -> None:
    # Shared flags live on a parent parser attached to every subcommand, so they
    # are accepted both before and after the subcommand name.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-url", default=DEFAULT_BASE_URL)
    common.add_argument("--time-range", default=DEFAULT_TIME_RANGE, help="e.g. 30m, 24h, 7d")
    common.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    common.add_argument("--json", action="store_true", help="raw JSON output")
    common.add_argument("--no-redact", action="store_true", help="disable email/IP redaction")
    common.add_argument("--show-stacktraces", action="store_true", help="full multi-line log bodies")

    parser = argparse.ArgumentParser(description=__doc__, parents=[common])
    sub = parser.add_subparsers(dest="command", required=True)

    def sub_parser(name: str, help_text: str) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help_text, parents=[common])

    p = sub_parser("list-traces", "recent traces, newest first")
    p.add_argument("--service")
    p.add_argument("--errors-only", action="store_true")
    p.set_defaults(func=cmd_list_traces)

    p = sub_parser("trace-detail", "one trace: summary + error spans")
    p.add_argument("trace_id")
    p.set_defaults(func=cmd_trace_detail)

    p = sub_parser("trace-spans", "span list for a trace")
    p.add_argument("trace_id")
    p.set_defaults(func=cmd_trace_spans)

    p = sub_parser("list-sessions", "recent sessions incl. GenAI cost")
    p.add_argument("--active-only", action="store_true")
    p.set_defaults(func=cmd_list_sessions)

    p = sub_parser("session-traces", "traces for one session")
    p.add_argument("session_id")
    p.set_defaults(func=cmd_session_traces)

    p = sub_parser("search-logs", "log search with filters")
    p.add_argument("--trace-id")
    p.add_argument("--service")
    p.add_argument("--severity-min", type=int, help="OTel number: 9 INFO, 13 WARN, 17 ERROR")
    p.add_argument("--query")
    p.set_defaults(func=cmd_search_logs)

    args = parser.parse_args()
    args.limit = max(1, min(args.limit, MAX_LIMIT))
    args.func(Api(args.base_url), args)


if __name__ == "__main__":
    main()
