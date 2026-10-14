# qyl.mcp: release and pins

One agent per qyl-dev repo (qyl, qyl.mcp, qyl-api-schema, Qyl.Telemetry.AutoInstrumentation, Qyl.Telemetry.SemanticConventions, qyl.at), each on its own `main`; agent, user and owner are one word. No PR, no CI, no publishing workflow: releases run on this machine with the keys in Vitals (`vitals keys`).

## This repository

- Publishes `qyl-mcp-server` (npm) from `server/`.
- Version source: `server/package.json` `version` plus a `## <x.y.z>` entry at the top of `CHANGELOG.md` (last three entries; older ones in `CHANGELOG.archive.md`), which becomes the GitHub release notes. `./release.sh` bumps the version, both workspace self-pins and `bun.lock`; its header says the rest.
- Key: Vitals entry "qyl-api-schema and qyl.mcp manual publish and release (npm)", `~/.config/vitals/npm-qyl-manual-publish-token`, read by the script. Never print, paste, commit or log it. Entry missing, note expired, "npm token rejected" or an npm one-time-password prompt: stop and tell the owner.
- Upstream pins: `@ancplua/qyl-api-schema` in `server/`, `workbench/`, `dashboard/` `package.json`; `@ancplua/qyl-semantic-conventions` in `server/` and `workbench/` `package.json`; both in the root `bun.lock`.

## Stale-version guard, before any work

1. `git pull --ff-only origin main`, `mise install`, `bun install --frozen-lockfile`.
2. `npm view <package> version` for both upstream pins; if the index is ahead, re-pin first.

## Release

1. Commit the `## <x.y.z>` entry at the top of `CHANGELOG.md` on `main` (move the oldest of the four entries to `CHANGELOG.archive.md`).
2. `./release.sh <x.y.z>` (`--dry-run` first only when a step is new or unsure; the script refuses before publishing when anything is off).
3. If it ends "not visible yet", poll `npm view qyl-mcp-server@<x.y.z> version` every 15 s; nothing else about this release until indexed.
4. Indexed: notify the consumers.
5. Run `/Users/alexandernachtmann/RiderProjects/qyl.at/scripts/refresh-published-versions.sh` (rewrites, commits and pushes `published-versions.yaml` in qyl.at, the snapshot every agent reads first).

## Notify

| Consumer | Re-pins |
|---|---|
| qyl.at | `src/data/site.ts` |

One message per consumer through the session's agent-messaging tool (Claude Code: `ListAgents`, then `SendMessage`):

```
RELEASE qyl-mcp-server <version> indexed <UTC time>
repo: qyl.at
re-pin: src/data/site.ts
then: regenerate the lockfile, run the gate, commit, push main
```

## Re-pin when an upstream release lands

Act at once, before your own work:

1. Set the new version in every manifest under "Upstream pins"; `bun install` (not frozen, it rewrites `bun.lock`); `mise run check`.
2. Contract revision changed: wait until `https://api.qyl.at/health` serves it. qyl (the Collector) pushes first; mcp.qyl.at refuses a Collector on another revision and Railway stops the old container first, so the reverse order takes mcp.qyl.at down.
3. Commit `chore: pin <package> <version>`, push `main`.
4. If the pin changes what the server ships, write the release-notes entry and release: one release per repo per wave.

## Deployment state

`railway deployment list --project <project-id> --service qyl-mcp --environment production --json` (`qyl-collector` for the Collector; pass the project, these clones have no Railway link): the newest entry shows `status: SUCCESS` and `meta.commitHash` = the pushed commit. `curl -fsSL https://api.qyl.at/health` shows the Collector's contract revision, `https://mcp.qyl.at/healthz` the server's state.
