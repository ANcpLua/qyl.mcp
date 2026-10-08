#!/usr/bin/env python3
"""Repo-checkable completion criteria from goal-objective.md, point 14.

Based on docs/evidence/2026-10-08-step7.md. This does not verify production,
portal state, owner attestations or the semantic truth of arbitrary prose.
"""

import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

from jsonschema import Draft202012Validator
from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parent.parent
MARKDOWN = MarkdownIt("commonmark").enable("table")
REQUIRED_BUNDLE_FILES = (
    "plugin.json", "mcp.json", ".claude-plugin/plugin.json", ".mcp.json",
    "README.md", "LICENSE", "assets/qyl-icon.png", "skills/qyl-investigate/SKILL.md",
)
REQUIRED_HANDOFF_FILES = (
    "submission/README.md", "submission/anthropic-connector-listing.md",
    "submission/public-pages-draft.md", "release/contract.md", "release/README.md",
)
NATIVE_FIELDS = {
    "id", "toolName", "status", "createdAt", "startedAt", "completedAt",
    "durationMs", "errorType",
}


class AuditFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AuditFailure(message)


def read_json(path):
    return json.loads(path.read_text())


def inline_tokens(tokens):
    for token in tokens:
        if token.type == "inline":
            yield from token.children or []


def plain_text(tokens):
    return "".join(token.content if token.type in ("text", "code_inline", "image")
                   else " " if token.type in ("softbreak", "hardbreak") else ""
                   for token in tokens)


def heading_ids(source):
    tokens = MARKDOWN.parse(source)
    used = set()
    for index, token in enumerate(tokens):
        if token.type != "heading_open":
            continue
        text = plain_text(tokens[index + 1].children or []).lower()
        base = re.sub(r"[^\w\- ]", "", text).replace(" ", "-")
        slug, number = base, 0
        while slug in used:
            number += 1
            slug = f"{base}-{number}"
        used.add(slug)
    return used


def check_native_record(source):
    # Fail closed when the declaration changes shape. This source check does not
    # import the server (which would initialize runtime dependencies/storage).
    match = re.search(
        r"^const NativeExecutionRecordSchema\s*=\s*z\.object\(\{(.*?)^\}\)\.strict\(\);",
        source, re.M | re.S,
    )
    require(match is not None, "native record must be a directly declared strict z.object")
    body = re.sub(r"/\*.*?\*/|//[^\n]*", "", match.group(1), flags=re.S)
    fields = []
    for line in body.splitlines():
        if not line.strip():
            continue
        field = re.fullmatch(r"\s*([A-Za-z_$][\w$]*)\s*:\s*.+,\s*", line)
        require(field is not None, "native record has an unreviewed field form (spread/computed/multiline)")
        fields.append(field.group(1))
    require(len(fields) == len(set(fields)), "native record has duplicate fields")
    require(set(fields) == NATIVE_FIELDS,
            f"native record must contain only reviewed metadata fields; found {fields}")


def check_descriptions(tools):
    require(len(tools) == 11 and len({t["name"] for t in tools}) == 11,
            "manifest must describe all 11 distinct tools")
    for tool in tools:
        description = tool.get("description", "")
        require("when the user" in description.lower(), f"{tool['name']}: missing user-need description")
        require(not re.search(r"\b(model|should|must)\b|\b(?:do not|never)\s+(?:call|use|invoke)\b", description, re.I),
                f"{tool['name']}: model-directed description")


def check_ledger(source):
    # Inspect rendered table rows, not historical fenced command transcripts.
    tokens = MARKDOWN.parse(source)
    row = None
    for token in tokens:
        if token.type == "tr_open":
            row = []
        elif token.type == "inline" and row is not None:
            row.append(plain_text(token.children or []))
        elif token.type == "tr_close":
            require(not re.search(r"\bnot\s+recorded\b", " ".join(row or []), re.I),
                    "ledger contains a 'not recorded' row")
            row = None


def documentation_files(root):
    # Goal/handoff surfaces and their evidence; SDK reference docs are separate.
    files = [root / name for name in (
        "README.md", "AGENTS.md", "goal-objective.md", "MCP-CHECKPOINT.md",
        "QYL-MCP-MATRIX.md", "MCP-V2-INTEROP-TODO.md",
    )]
    for directory in ("submission", "release", "docs/evidence"):
        files.extend(sorted((root / directory).rglob("*.md")))
    return files


def check_links(root, documents):
    links = 0
    headings = {}
    for path in documents:
        for token in inline_tokens(MARKDOWN.parse(path.read_text())):
            target = token.attrGet("href") if token.type == "link_open" else token.attrGet("src") if token.type == "image" else None
            if target is None:
                continue
            parts = urlsplit(target)
            if parts.scheme or parts.netloc:
                continue
            destination = (path.parent / unquote(parts.path)).resolve() if parts.path else path.resolve()
            require(destination.is_relative_to(root.resolve()), f"{path.relative_to(root)}: link escapes repository: {target}")
            require(destination.exists(), f"{path.relative_to(root)}: missing local link: {target}")
            if parts.fragment and destination.suffix == ".md":
                if destination not in headings:
                    headings[destination] = heading_ids(destination.read_text())
                require(unquote(parts.fragment) in headings[destination],
                        f"{path.relative_to(root)}: missing heading: {target}")
            links += 1
    return links


def audit(root=ROOT):
    bundle = root / "submission/qyl"
    for name in REQUIRED_BUNDLE_FILES:
        path = bundle / name
        require(path.is_file() and not path.is_symlink(), f"missing regular bundle file: {name}")
    for name in REQUIRED_HANDOFF_FILES:
        require((root / name).is_file(), f"missing handoff file: {name}")
    for name in ("plugin", "mcp"):
        schema = read_json(root / f"submission/schemas/{name}.schema.json")
        value = read_json(bundle / f"{name}.json")
        require(value.get("$schema") == schema["$id"], f"{name}.json: wrong declared schema")
        Draft202012Validator.check_schema(schema)
        errors = sorted(Draft202012Validator(schema).iter_errors(value), key=lambda error: str(error.path))
        require(not errors, f"{name}.json: " + "; ".join(error.message for error in errors))
    tokens = MARKDOWN.parse((bundle / "README.md").read_text())
    words = len(" ".join(token.content for token in tokens if token.type == "inline").split())
    require(words >= 40, f"bundle README has {words} words outside code blocks; need at least 40")
    check_descriptions(read_json(root / "server/tool-manifest.snapshot.json")["tools"])
    check_native_record((root / "server/src/native-execution.ts").read_text())
    check_ledger((root / "MCP-V2-INTEROP-TODO.md").read_text())
    links = check_links(root, documentation_files(root))
    return [
        f"PASS: {len(REQUIRED_BUNDLE_FILES)} bundle files and {len(REQUIRED_HANDOFF_FILES)} handoff files",
        "PASS: plugin.json and mcp.json validate against submission/schemas (Draft 2020-12)",
        f"PASS: README {words} words outside code blocks (minimum 40)",
        "PASS: all 11 tool descriptions state user need without model instructions",
        "PASS: strict native record contains only reviewed metadata; no arguments/_meta",
        "PASS: ledger has no not-recorded table rows",
        f"PASS: {links} local documentation/evidence links and heading anchors resolve",
        "Completion audit passed; production, owner actions and prose evidence still require review.",
    ]


if __name__ == "__main__":
    try:
        print("\n".join(audit()))
    except (AuditFailure, OSError, ValueError, KeyError) as error:
        print(f"Completion audit failed: {error}", file=sys.stderr)
        sys.exit(1)
