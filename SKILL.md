# qyl.mcp: release and pins

Use the existing qyl stack clones on `main`, with one writer per repository. Do not create another agent, branch, worktree or PR unless requested. CI only reports; releases run on this machine with the keys in Vitals (`vitals keys`).

## This repository

- Publishes `qyl-mcp-server` (npm) from `server/`.
- Version source: `server/package.json` `version` plus a `## <x.y.z>` entry at the top of `CHANGELOG.md` (last three entries; older ones in `CHANGELOG.archive.md`), which becomes the GitHub release notes. `./release.sh` bumps the version, both workspace self-pins and `bun.lock`; its header says the rest.
- Key: Vitals entry "qyl-api-schema and qyl.mcp manual publish and release (npm)", `~/.config/vitals/npm-qyl-manual-publish-token`, read by the script. Never print, paste, commit or log it. Entry missing, note expired, "npm token rejected" or an npm one-time-password prompt: stop and tell the owner.
- Upstream pins: `@ancplua/qyl-api-schema` in `server/`, `workbench/`, `dashboard/` `package.json`; `@ancplua/qyl-semantic-conventions` in `server/` and `workbench/` `package.json`; both in the root `bun.lock`.

## Refresh changed inputs

1. Pull when the tree is clean and no other writer owns it. Install missing tool versions; run `bun install --frozen-lockfile` when dependency inputs change.
2. Compare the upstream pins with the registries once per release wave and group the required upgrades. Reuse that comparison and passing checks until their inputs change.

## Release

1. Commit the `## <x.y.z>` entry at the top of `CHANGELOG.md` on `main` (move the oldest of the four entries to `CHANGELOG.archive.md`).
2. `./release.sh <x.y.z>` (`--dry-run` first only when a step is new or unsure; the script refuses before publishing when anything is off). It returns before indexing, once npm accepted the tarball and the tag and GitHub release exist; a detached job waits for npm, checks the registry tarball and refreshes the snapshot (`published-versions.yaml` in qyl.at), logging to `artifacts/release-<x.y.z>-verify.log`. Do not run the snapshot refresh by hand.
3. `./release.sh --wait <x.y.z>` follows the existing job until its log ends in VERIFIED or FAILED. One job owns the attempt: do not restart a healthy job because a fixed time elapsed or duplicate its registry polling. Continue independent work while it waits. `./release.sh --verify <x.y.z>` retries verification after a transient failure; a defective immutable package needs a patch release.
4. Require VERIFIED before reporting completion or upgrading consumers.

## Consumers

| Consumer | Re-pins |
|---|---|
| qyl.at | `src/data/site.ts` |

After VERIFIED, update authorized consumers in their existing clones, recording the released version and evidence. Coordinate with an existing writer if one owns a consumer; do not create an agent just to deliver a notification.

## Re-pin when an upstream release lands

Group upgrades with the clone's next relevant change:

1. Set the new version in every manifest under "Upstream pins" and run `bun install` to update `bun.lock`. Verify affected behavior and pins, reusing valid checks; broaden only for a concrete unresolved concern or an explicit full-check request.
2. Contract revision changed: wait until `https://api.qyl.at/health` serves it. qyl (the Collector) pushes first; mcp.qyl.at refuses a Collector on another revision and Railway stops the old container first, so the reverse order takes mcp.qyl.at down.
3. Commit `chore: pin <package> <version>`, push `main`.
4. If the pin changes what the server ships, write the release-notes entry and release: one release per repo per wave.

## Deployment state

`railway deployment list --project <project-id> --service qyl-mcp --environment production --json` (`qyl-collector` for the Collector; pass the project, these clones have no Railway link): the newest entry shows `status: SUCCESS` and `meta.commitHash` = the pushed commit. `curl -fsSL https://api.qyl.at/health` shows the Collector's contract revision, `https://mcp.qyl.at/healthz` the server's state.
