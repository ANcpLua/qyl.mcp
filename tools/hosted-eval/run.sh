#!/usr/bin/env bash
# The hosted-server test: a bearer token for https://mcp.qyl.at/mcp (Keychain
# refresh first, browser once), then reads, scope challenges and validation over
# Streamable HTTP at protocol revision 2026-07-28 with the official client.
# This does not prove successful owner operations for all 32 tools.
#   mise run hosted-eval   (tools/hosted-eval/run.sh)            refresh from Keychain, else browser
#   mise run hosted-eval   (tools/hosted-eval/run.sh) --browser  force the browser flow (new consent)
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
[ -e "$H/node_modules" ] || ln -s "$H/../../server/node_modules" "$H/node_modules"
[ -d "$H/node_modules/@modelcontextprotocol/client" ] || { echo "missing: bun install in qyl.mcp/server first" >&2; exit 2; }
token_file=$(python3 "$H/login.py" "$@" --print-token-path) || exit $?
python3 "$H/login.py" "$@" || exit $?
export QYL_HOSTED_TOKEN_FILE="$token_file"
exec node "$H/eval.mjs"
