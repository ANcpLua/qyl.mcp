#!/usr/bin/env bash
# Publish and release qyl-mcp-server (server/) to npm from this machine with the token
# registered in Vitals. No workflow publishes.
#
#   ./release.sh <x.y.z>            bump server/package.json, publish, push main, tag, GitHub release;
#                                   returns once npm accepted the tarball and the tag and the GitHub
#                                   release exist, and leaves the verification below running detached
#   ./release.sh <x.y.z> --dry-run  every check plus `bun publish --dry-run` (runs the build);
#                                   registry and git stay unchanged; prints what the detached job would do
#   ./release.sh --wait <x.y.z>     blocks until artifacts/release-<x.y.z>-verify.log ends in VERIFIED
#                                   (exit 0) or FAILED (exit 1), printing the log as it grows
#   ./release.sh --verify <x.y.z>   starts the detached verification again for a released version
#
# The detached verification (own session, survives the caller's shell) waits until npm serves
# <x.y.z> (up to 15 min), checks the registry tarball is byte-identical to the packed one, runs
# qyl.at's scripts/refresh-published-versions.sh and ends its log with VERIFIED or FAILED. npm
# versions are immutable: a failure after the fact is a patch release, and the log says so.
#
# Before the real run: add the `## <x.y.z>` entry at the top of CHANGELOG.md and commit it on
# main; the script refuses without it and uses it as the release notes.
set -euo pipefail
cd "$(dirname "$0")"

NPM_PKG=qyl-mcp-server
NPM_REGISTRY=https://registry.npmjs.org
NPM_TOKEN_FILE=$HOME/.config/vitals/npm-qyl-manual-publish-token  # vitals keys: "... manual publish and release (npm)"
QYL_AT_DIR=${QYL_AT_DIR:-$(cd .. && pwd)/qyl.at}

mode=release
case ${1:-} in --wait | --verify | __verify) mode=${1#--}; shift ;; esac
version=${1:-}
dry=0; [[ $mode == release && ${2:-} == --dry-run ]] && dry=1
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <x.y.z> [--dry-run] | --wait <x.y.z> | --verify <x.y.z>" >&2; exit 2; }
say() { printf '\n== %s\n' "$*"; }
die() { echo "release: $*" >&2; exit 1; }
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Resolve from the canonical checkout before entering the archive snapshot.
bun_path=$(mise which bun) || die "install the pinned Bun with mise install"
node_path=$(mise which node) || die "install the pinned Node.js with mise install"
export PATH="$(dirname "$bun_path"):$(dirname "$node_path"):$PATH"
verify_log="$PWD/artifacts/release-$version-verify.log"
verify_pid() { sed -n '1s/.* pid \([0-9][0-9]*\) .*/\1/p' "$verify_log"; }

# The detached job. Its first log line names its pid, its last line is the verdict.
verify_published() {
  local tarball=${1:-} step="start" published
  tmp=$(mktemp -d)  # global: the EXIT trap removes it after this function returned
  printf 'verify %s %s pid %s started %s\n' "$NPM_PKG" "$version" "$$" "$(utc)"
  trap 'rc=$?; rm -rf "$tmp"; (( rc == 0 )) || printf "FAILED %s %s %s: %s stopped (exit %s); fix the cause, then ./release.sh --verify %s\n" "$NPM_PKG" "$version" "$(utc)" "$step" "$rc" "$version"' EXIT
  fail() { printf 'FAILED %s %s %s: %s\n' "$NPM_PKG" "$version" "$(utc)" "$*"; trap 'rm -rf "$tmp"' EXIT; exit 1; }
  next_patch="${version%.*}.$(( ${version##*.} + 1 ))"

  step="index wait"
  say "wait until npm serves $NPM_PKG@$version (up to 15 min)"
  for _ in $(seq 1 60); do
    published=$(npm view "$NPM_PKG@$version" version --registry="$NPM_REGISTRY" 2>/dev/null || true)
    [[ $published == "$version" ]] && break
    sleep 15
  done
  [[ $published == "$version" ]] || fail "npm does not serve $version after 15 min; ./release.sh --verify $version checks again"
  printf 'INDEXED %s %s %s\n' "$NPM_PKG" "$version" "$(utc)"

  step="release smoke"
  say "registry tarball against the captured artifact"
  if [[ -z $tarball ]]; then
    gh release download "v$version" --pattern "$NPM_PKG-$version.tgz" --dir "$tmp"
    tarball="$tmp/$NPM_PKG-$version.tgz"
  fi
  curl -fsSL "$(npm view "$NPM_PKG@$version" dist.tarball --registry="$NPM_REGISTRY")" -o "$tmp/published.tgz"
  cmp -s "$tarball" "$tmp/published.tgz" ||
    fail "the npm tarball differs from the captured artifact $tarball; $version is immutable: fix the cause and ship $next_patch as a patch release"
  echo "registry tarball is byte-identical to $tarball"

  step="snapshot refresh"
  say "refresh the published-versions snapshot in qyl.at"
  "$QYL_AT_DIR/scripts/refresh-published-versions.sh" ||
    fail "$version is published and verified, but the snapshot refresh failed (above); ./release.sh --verify $version retries it"

  trap 'rm -rf "$tmp"' EXIT
  printf 'VERIFIED %s %s %s: npm serves it, registry tarball byte-identical, snapshot refreshed\n' "$NPM_PKG" "$version" "$(utc)"
}

# nohup plus a new session (python3's setsid; macOS has no setsid command): neither the end of the
# caller's shell nor a signal to its process group reaches the job.
start_verification() {
  mkdir -p artifacts
  if [[ -f $verify_log ]] && ! tail -n 1 "$verify_log" | grep -Eq '^(VERIFIED|FAILED) '; then
    pid=$(verify_pid)
    [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && die "the verification of $version is still running (pid $pid): ./release.sh --wait $version"
  fi
  : >"$verify_log"
  nohup python3 -I -c 'import os, sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])' \
    "$PWD/release.sh" __verify "$version" "$@" </dev/null >>"$verify_log" 2>&1 &
  disown
  # Return only once the job has logged its pid, so a --wait right after this finds it.
  for _ in $(seq 1 50); do [[ -n $(verify_pid) ]] && break; sleep 0.2; done
  [[ -n $(verify_pid) ]] || die "the detached verification did not start; read $verify_log"
  say "verification runs detached (pid $!)"
  echo "log:  $verify_log"
  echo "wait: ./release.sh --wait $version   (or: tail -f $verify_log)"
}

wait_for_verification() {
  local printed=0 lines pid alive
  [[ -f $verify_log ]] || die "no verification log for $version at $verify_log; ./release.sh --verify $version starts one"
  while :; do
    pid=$(verify_pid); alive=0
    [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && alive=1
    lines=$(wc -l <"$verify_log" | tr -d ' ')
    (( lines > printed )) && { sed -n "$((printed + 1)),${lines}p" "$verify_log"; printed=$lines; }
    case $(tail -n 1 "$verify_log") in
      VERIFIED\ *) return 0 ;;
      FAILED\ *) return 1 ;;
    esac
    (( alive )) || die "the verification job (pid ${pid:-unknown}) ended without VERIFIED or FAILED; read $verify_log, then ./release.sh --verify $version"
    sleep 5
  done
}

case $mode in
  __verify) verify_published "${2:-}"; exit 0 ;;
  wait) wait_for_verification; exit ;;
  verify)
    [[ -n $(git ls-remote --tags origin "refs/tags/v$version") ]] || die "tag v$version is not on origin; release it first"
    gh release view "v$version" >/dev/null 2>&1 || die "GitHub release v$version does not exist; release it first"
    start_verification
    exit 0 ;;
esac

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
  echo "The real run then starts the detached verification ($verify_log, ./release.sh --wait $version):"
  echo "  wait until npm serves $NPM_PKG@$version (up to 15 min), compare the registry tarball with $package_tar,"
  echo "  run $QYL_AT_DIR/scripts/refresh-published-versions.sh, end the log with VERIFIED or FAILED."
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

start_verification "$package_tar"
echo "Railway deploys mcp.qyl.at from main; next (SKILL.md): ./release.sh --wait $version, then notify qyl.at."
