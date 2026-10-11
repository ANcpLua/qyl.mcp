#!/usr/bin/env bash
# Publish and release qyl-mcp-server (server/) to npm from this machine with the token
# registered in Vitals. No workflow publishes.
#
#   ./release.sh <x.y.z>            bump server/package.json, publish, push main, tag, GitHub release
#   ./release.sh <x.y.z> --dry-run  every check plus `bun publish --dry-run` (runs the build);
#                                   registry and git stay unchanged
#
# Before the real run: add the `### <x.y.z>` entry under `## Release notes` in server/README.md
# and commit it on main; the script refuses without it and uses it as the release notes.
set -euo pipefail
cd "$(dirname "$0")"

NPM_PKG=qyl-mcp-server
NPM_REGISTRY=https://registry.npmjs.org
NPM_TOKEN_FILE=$HOME/.config/vitals/npm-qyl-manual-publish-token  # vitals keys: "... manual publish and release (npm)"

version=${1:-}
dry=0; [[ ${2:-} == --dry-run ]] && dry=1
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <x.y.z> [--dry-run]" >&2; exit 2; }
say() { printf '\n== %s\n' "$*"; }
die() { echo "release: $*" >&2; exit 1; }

say "checks"
[[ -r $NPM_TOKEN_FILE ]] || die "npm token missing: $NPM_TOKEN_FILE (vitals keys)"
[[ $(git branch --show-current) == main ]] || die "not on main"
[[ -z $(git status --porcelain --untracked-files=no) ]] || die "working tree not clean"
git fetch -q origin main
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || die "main differs from origin/main"
[[ -z $(git ls-remote --tags origin "refs/tags/v$version") ]] || die "tag v$version already on origin"
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && die "tag v$version already exists locally"
[[ -z $(npm view "$NPM_PKG@$version" version --registry="$NPM_REGISTRY" 2>/dev/null) ]] || die "$NPM_PKG@$version is already on npm"
if ! grep -q "^### $version\$" server/README.md; then
  (( dry )) || die "server/README.md has no '### $version' entry under '## Release notes'"
  echo "warning: server/README.md has no '### $version' entry yet; the real run refuses without it"
fi
gh auth status >/dev/null 2>&1 || die "gh is not logged in"

# Token check through a private npm userconfig; bun itself reads NPM_CONFIG_TOKEN.
npmrc=$(mktemp); chmod 600 "$npmrc"
notes=$(mktemp)
trap 'rm -f "$npmrc" "$notes"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$(<"$NPM_TOKEN_FILE")" >"$npmrc"
who=$(NPM_CONFIG_USERCONFIG=$npmrc npm whoami --registry="$NPM_REGISTRY") || die "npm token rejected (vitals keys)"
echo "npm token belongs to: $who"
awk -v v="$version" '$0 == "### " v {on=1; next} on && /^### / {exit} on' server/README.md >"$notes"

say "version"
if (( dry )); then
  echo "dry run: publishing $(node -p "require('./server/package.json').version") with --dry-run, version untouched"
else
  (cd server && npm version "$version" --no-git-tag-version >/dev/null)
  bun install --lockfile-only
  git add server/package.json bun.lock
  git commit -q -m "release: $NPM_PKG $version"
fi

say "bun publish (prepack builds)"
(cd server && NPM_CONFIG_TOKEN=$(<"$NPM_TOKEN_FILE") bun publish --registry "$NPM_REGISTRY" --access public $( (( dry )) && echo --dry-run ))

if (( dry )); then
  say "dry run finished: nothing published, nothing committed"
  git status --short --untracked-files=no
  exit 0
fi

say "push, tag and GitHub release"
git push -q origin main
git tag -a "v$version" -m "v$version"
git push -q origin "v$version"
gh release create "v$version" --title "v$version" --notes-file "$notes"

say "verify"
for _ in $(seq 1 10); do
  v=$(npm view "$NPM_PKG@$version" version --registry="$NPM_REGISTRY" 2>/dev/null || true)
  [[ -n $v ]] && { echo "npm: $NPM_PKG $v"; break; }
  sleep 15
done
[[ -n ${v:-} ]] || echo "npm: $version not visible yet; check npm view $NPM_PKG version"
echo "Railway deploys mcp.qyl.at from main; follow the Release ripple in AGENTS.md for downstream pins."
