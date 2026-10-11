# qyl.mcp: release, pins and agent hand-offs

Who reads this: the one agent working on this repository's `main`. Agent, user and owner are
the same word. There is one agent per repository, six in all (qyl, qyl.mcp, qyl-api-schema,
Qyl.Telemetry.AutoInstrumentation, Qyl.Telemetry.SemanticConventions, qyl.at), each on its own
`main`. Commit and push to `main` directly: no pull requests, no CI, no branch rules. The gate
is `mise run check`; bun is the package manager (workspace lock `bun.lock` at the root).

## This repository

- Publishes to npm: `qyl-mcp-server` from `server/`. Pushing `main` also deploys the hosted
  server (`qyl-mcp`, mcp.qyl.at, Railway).
- Version source: `server/package.json` `version` plus a `### <x.y.z>` entry under
  `## Release notes` in `server/README.md`. Write the README entry and commit it first; the
  release command bumps the version and `bun.lock` itself and uses the entry as the GitHub
  release notes.
- Release command: `./release.sh <x.y.z> --dry-run`, then `./release.sh <x.y.z>`
  (`bun publish`, push `main`, tag, GitHub release, wait for npm).
- Key: `vitals keys` entry "qyl-api-schema and qyl.mcp manual publish and release (npm)", file
  `~/.config/vitals/npm-qyl-manual-publish-token`, used as `NPM_CONFIG_TOKEN` by the script.
  Never print, paste, commit or log it. If the entry is missing, its note's expiry has passed,
  or the script says "npm token rejected" or npm asks for a one-time password, stop and tell
  the owner.
- Upstream pins this repo must keep fresh: `@ancplua/qyl-api-schema` in `server/package.json`,
  `workbench/package.json`, `dashboard/package.json`, and the root `bun.lock`.
- Telemetry definitions: `@ancplua/qyl-semantic-conventions` in `server/package.json` and
  `workbench/package.json` (test dependency), plus `bun.lock`. Re-pin from the
  SemanticConventions release notification and run the same local gate.
- Consumers to notify after this repo's release is indexed: qyl.at (`src/data/site.ts` lists
  `qyl-mcp-server`).

## Before any work: the stale-version guard

1. `git pull --ff-only origin main`.
2. `mise install`, then `bun install --frozen-lockfile`.
3. Compare the pinned `@ancplua/qyl-api-schema` with `npm view @ancplua/qyl-api-schema version`.
   If a newer version is indexed, re-pin first (section "When a release lands"), then start
   the actual work. Never build on a pin older than what is indexed.

## Releasing

1. Commit the `### <x.y.z>` release-notes entry in `server/README.md` on `main`.
2. `./release.sh <x.y.z> --dry-run`; fix whatever it refuses.
3. `./release.sh <x.y.z>`.
4. Watch indexing: the script polls `npm view qyl-mcp-server@<x.y.z> version`. If it ends with
   "not visible yet", keep polling every 15 s. Until it is indexed, do nothing else about this
   release.
5. The moment it is indexed: stop watching and notify qyl.at (section "Notify").
6. Record the published version in
   `/Users/alexandernachtmann/Downloads/qyl-codex-claude/qyl-handoff-for-codex.md` and rewrite
   `/Users/alexandernachtmann/Downloads/qyl-codex-claude/qyl-published-versions.yaml` (the
   registries are the truth; this file is the snapshot every agent reads first), and update
   `qyl-mcp-32-tools-both-platforms.md` there when the tool set changed.

## Notify

One message per consumer repo, to its running agent through the session's agent-messaging
tool when there is one (Claude Code: `ListAgents`, then `SendMessage`). If the consumer has
no running agent, append the same text to the handoff file above under "Pending re-pins";
the owner relays it. Text:

```
RELEASE qyl-mcp-server <version> indexed <UTC time>
repo: qyl.at
re-pin: src/data/site.ts
then: regenerate the lockfile, run the gate, commit, push main
```

## When a release lands and you are the consumer

Act at once, before continuing your own work, so both agents keep moving:

1. Set the new `@ancplua/qyl-api-schema` version in the three `package.json` files.
2. `bun install` (not frozen: it rewrites `bun.lock` to the new pin). Prefer bun; `npm install`
   or `pnpm install` only where a package has that lockfile instead.
3. `mise run check`.
4. If the contract revision changed, wait until `https://api.qyl.at/health` serves the new
   revision (qyl pushes first); mcp.qyl.at refuses a Collector on another revision.
5. Commit `chore: pin @ancplua/qyl-api-schema <version>` and push `main` immediately. The push
   deploys mcp.qyl.at.
6. If the pin changes what the server ships, write the release-notes entry and continue with
   "Releasing": one release per repo per wave.

## Order rules that never change

- Contract revision: qyl (Collector) first, then qyl.mcp.
- Deployment state, from this Mac: `railway deployment list --json` in this clone (linked to
  project qyl, service `qyl-mcp`, environment `production`) or in the qyl clone (`qyl-collector`);
  the newest entry must show `status: SUCCESS` and `meta.commitHash` equal to the pushed commit.
  `curl -fsSL https://api.qyl.at/health` shows the Collector's contract revision,
  `https://mcp.qyl.at/healthz` the server's state.
- qyl.at lists a version only after the index confirms it.
