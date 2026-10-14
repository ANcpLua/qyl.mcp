#!/usr/bin/env bash
# Publish and release qyl-mcp-server (server/) to npm from this machine with the token
# registered in Vitals. No workflow publishes.
#
#   ./release.sh <x.y.z>            bump server/package.json, publish, push main, tag, GitHub release
#   ./release.sh <x.y.z> --dry-run  every check plus `bun publish --dry-run` (runs the build);
#                                   registry and git stay unchanged
#
# Before the real run: add the `## <x.y.z>` entry at the top of CHANGELOG.md and commit it on
# main; the script refuses without it and uses it as the release notes.
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
# Resolve from the canonical checkout before entering the archive snapshot.
bun_path=$(mise which bun) || die "install the pinned Bun with mise install"
node_path=$(mise which node) || die "install the pinned Node.js with mise install"
export PATH="$(dirname "$bun_path"):$(dirname "$node_path"):$PATH"

say "checks"
[[ -r $NPM_TOKEN_FILE ]] || die "npm token missing: $NPM_TOKEN_FILE (vitals keys)"
[[ $(git branch --show-current) == main ]] || die "not on main"
[[ -z $(git status --porcelain) ]] || die "working tree not clean"
git fetch -q origin main
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || die "main differs from origin/main"
start_commit=$(git rev-parse HEAD)
[[ -z $(git ls-remote --tags origin "refs/tags/v$version") ]] || die "tag v$version already on origin"
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && die "tag v$version already exists locally"
[[ -z $(npm view "$NPM_PKG@$version" version --registry="$NPM_REGISTRY" 2>/dev/null) ]] || die "$NPM_PKG@$version is already on npm"
if ! grep -q "^## $version\$" CHANGELOG.md; then
  (( dry )) || die "CHANGELOG.md has no '## $version' entry"
  echo "warning: CHANGELOG.md has no '## $version' entry yet; the real run refuses without it"
fi
gh auth status >/dev/null 2>&1 || die "gh is not logged in"

# Token check through a private npm userconfig; bun itself reads NPM_CONFIG_TOKEN.
npmrc=$(mktemp); chmod 600 "$npmrc"
notes=$(mktemp)
trap 'rm -f "$npmrc" "$notes"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$(<"$NPM_TOKEN_FILE")" >"$npmrc"
who=$(NPM_CONFIG_USERCONFIG=$npmrc npm whoami --registry="$NPM_REGISTRY") || die "npm token rejected (vitals keys)"
echo "npm token belongs to: $who"
awk -v v="$version" '$0 == "## " v {on=1; next} on && /^## / {exit} on' CHANGELOG.md >"$notes"

say "version"
if (( dry )); then
  echo "dry run: publishing $(node -p "require('./server/package.json').version") with --dry-run, version untouched"
else
  node --input-type=module - "$version" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
for (const name of ["server", "workbench", "dashboard"]) {
  const path = `${name}/package.json`;
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  if (name === "server") metadata.version = process.argv[2];
  else metadata.dependencies["qyl-mcp-server"] = process.argv[2];
  writeFileSync(path, JSON.stringify(metadata, null, 2) + "\n");
}
NODE
  bun install --lockfile-only
  node verify-contract-pins.mjs
  [[ $(git rev-parse HEAD) == "$start_commit" ]] || die "HEAD changed during the version bump"
  git diff --cached --quiet || die "index changed during the version bump"
  while IFS= read -r changed; do
    case "$changed" in
      server/package.json|workbench/package.json|dashboard/package.json|bun.lock) ;;
      *) die "unexpected tracked change during the version bump: $changed" ;;
    esac
  done < <(git diff --name-only)
  git commit -q --only -m "release: $NPM_PKG $version" -- \
    server/package.json workbench/package.json dashboard/package.json bun.lock
fi

release_commit=$(git rev-parse HEAD)
assert_release_source() {
  [[ $(git rev-parse HEAD) == "$release_commit" ]] || die "HEAD changed while packing; refusing to publish"
  [[ -z $(git status --porcelain) ]] || die "source changed while packing; refusing to publish"
}
assert_release_source

# Export only the captured commit. Build output and the tarball are isolated
# release artifacts, not a Git worktree; concurrent working-tree edits cannot
# leak into the package. Keep the tarball and manifest if registry auth fails.
say "pack immutable commit $release_commit"
pack_root=$(mktemp -d "${TMPDIR:-/tmp}/qyl-mcp-release.XXXXXX")
snapshot="$pack_root/source"
mkdir "$snapshot"
git archive "$release_commit" | tar -x -C "$snapshot"
(cd "$snapshot" && bun install --frozen-lockfile)
(cd "$snapshot/server" && bun pm pack --destination "$pack_root")
packed_version=$(node -p "require(process.argv[1]).version" "$snapshot/server/package.json")
package_tar="$pack_root/$NPM_PKG-$packed_version.tgz"
[[ -f $package_tar ]] || die "packed tarball missing"
node --input-type=module - "$package_tar" "$release_commit" "$pack_root/release.json" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [tarball, commit, output] = process.argv.slice(2);
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(output, JSON.stringify({ commit, tarball, sha256 }, null, 2) + "\n");
console.log(`PACKED_COMMIT ${commit}\nPACKED_SHA256 ${sha256}\nARTIFACT_RECORD ${output}`);
NODE
assert_release_source
git fetch -q origin main
[[ $(git rev-parse origin/main) == "$start_commit" ]] || die "origin/main changed while packing; refusing to publish"

say "publish verified tarball"
(cd server && NPM_CONFIG_TOKEN=$(<"$NPM_TOKEN_FILE") bun publish "$package_tar" --registry "$NPM_REGISTRY" --access public $( (( dry )) && echo --dry-run ))

if (( dry )); then
  assert_release_source
  say "dry run finished: nothing published, nothing committed"
  exit 0
fi

say "push, tag and GitHub release for $release_commit"
# A concurrent push after registry acceptance must never move the release tag
# to a different HEAD. Push only the packed commit, or keep a newer descendant.
git fetch -q origin main
if ! git merge-base --is-ancestor "$release_commit" origin/main; then
  git push -q origin "$release_commit:refs/heads/main"
fi
git tag -a "v$version" "$release_commit" -m "v$version"
git push -q origin "v$version"
gh release create "v$version" --title "v$version" --notes-file "$notes" "$package_tar" "$pack_root/release.json"

say "verify"
for _ in $(seq 1 10); do
  v=$(npm view "$NPM_PKG@$version" version --registry="$NPM_REGISTRY" 2>/dev/null || true)
  [[ $v == "$version" ]] && {
    printf 'INDEXED %s %s %s\n' "$NPM_PKG" "$v" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    break
  }
  sleep 15
done
if [[ ${v:-} == "$version" ]]; then
  published_url=$(npm view "$NPM_PKG@$version" dist.tarball --registry="$NPM_REGISTRY")
  curl -fsSL "$published_url" -o "$pack_root/published.tgz"
  cmp -s "$package_tar" "$pack_root/published.tgz" || die "published tarball differs from the captured artifact"
  echo "Verified registry tarball is byte-identical to $release_commit"
else
  echo "npm: $version not visible yet; check npm view $NPM_PKG version"
fi
echo "Railway deploys mcp.qyl.at from main; next (SKILL.md): notify qyl.at once indexed, then refresh the snapshot."
