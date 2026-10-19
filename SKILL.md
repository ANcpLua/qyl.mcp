# qyl.mcp: release and pins

Publishes `qyl-mcp-server` (npm) from `server/`. Releases run on this machine; CI only reports.

- Version: `server/package.json` `version` plus a `## <x.y.z>` entry at the top of `CHANGELOG.md` (the last three entries; older ones move to `CHANGELOG.archive.md`). The entry becomes the GitHub release notes.
- Key: Vitals entry "qyl-api-schema and qyl.mcp manual publish and release (npm)", `~/.config/vitals/npm-qyl-manual-publish-token`, read by the script. Never print, paste, commit or log it. Missing, expired or rejected ("npm token rejected", a one-time-password prompt): stop and tell the owner.
- Pins: `@ancplua/qyl-api-schema` and `@ancplua/qyl-semantic-conventions` in `server/package.json` and `bun.lock`. Set the version, run `bun install`, commit `chore: pin <package> <version>`.
- Contract revision: mcp.qyl.at refuses a Collector on another contract revision, so a pin that changes it deploys only after `https://api.qyl.at/health` serves the new revision.

## Release

1. Commit the `## <x.y.z>` entry on `main`.
2. `./release.sh <x.y.z>` bumps the version, publishes, pushes `main`, tags and creates the GitHub release. A detached job then waits for npm, compares the registry tarball with the packed one and refreshes qyl.at's published-versions snapshot, logging to `artifacts/release-<x.y.z>-verify.log`.
3. `./release.sh --wait <x.y.z>` follows that job until VERIFIED or FAILED; `./release.sh --verify <x.y.z>` runs the verification again after a transient failure. A defective published version needs a patch release.

## Deployment

Railway deploys `main` to mcp.qyl.at (`.railway/railway.ts`). `https://mcp.qyl.at/healthz` answers once it is up; `railway deployment list --project <project-id> --service qyl-mcp --environment production --json` shows the deployed commit.
