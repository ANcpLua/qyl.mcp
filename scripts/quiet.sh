#!/usr/bin/env bash
# Runs gate steps quietly. The terminal gets one line per step (for a Fallout run, its target
# table), then PASS or FAIL with the total time and the log path; a failing step adds its last 60
# lines (for a Fallout run, the failing target's). The whole output goes to
# artifacts/logs/<name>.log. The exit code is the failing step's, else 0. QYL_VERBOSE=1 streams
# everything to the terminal instead.
#
#   scripts/quiet.sh <name> '<command>' ['<command>' ...]  each command through bash, in order,
#                                                         stopping at the first failure
#   scripts/quiet.sh <name> -- <program> [<argument> ...]  one step with exactly this argv
set -uo pipefail

name=$1
shift
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
single=0
if [[ ${1:-} == -- ]]; then
  single=1
  shift
fi

if [[ ${QYL_VERBOSE:-0} == 1 ]]; then
  if ((single)); then
    exec "$@"
  fi
  for command in "$@"; do
    printf '$ %s\n' "$command" >&2
    bash -ec "$command" || exit
  done
  exit 0
fi

log=$root/artifacts/logs/$name.log
work=$(mktemp -d "${TMPDIR:-/tmp}/quiet.XXXXXX")
# The log is written outside the repository and moved into place on exit, so a target that
# cleans artifacts/ cannot delete it mid-run.
trap 'mkdir -p "${log%/*}" && mv -f "$work/log" "$log"; rm -rf "$work"' EXIT
: >"$work/log"

duration() {
  if (($1 >= 60)); then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi
}

# Drops colour and cursor sequences and keeps the last state of a carriage-return progress line.
plain() {
  perl -pe 'BEGIN { $| = 1 } s/\e\[[0-?]*[ -\/]*[@-~]//g; s/\e\][^\a\e]*(?:\a|\e\\)//g; s/^.*\r(?=.)//; s/\r$//'
}

# The rows of the last Fallout target table in a step's output.
fallout_rows() {
  perl -ne 'if (/^Target\s+Status\s+Duration\s*$/) { @rows = (); $in = 1; next }
    if ($in && /^Total\s/) { $in = 0; next }
    if ($in && /^\S+\s+(?:Succeeded|Failed|Skipped|NotRun|Aborted)\b/) { s/\s+$//; push @rows, "$_\n" }
    END { print @rows }' "$1"
}

# The last lines of each failed Fallout target's block, or of the whole step output.
failure_tail() {
  perl -e 'my ($file, $budget) = @ARGV; open my $in, "<", $file or die; my @l = <$in>; chomp @l;
    my (@rows, $table);
    for (@l) {
      if (/^Target\s+Status\s+Duration\s*$/) { @rows = (); $table = 1; next }
      if ($table && /^Total\s/) { $table = 0; next }
      push @rows, $1 if $table && /^(\S+)\s+(?:Failed|Aborted)\b/;
    }
    my @blocks;
    for my $target (@rows[0 .. ($#rows < 2 ? $#rows : 2)]) {
      my ($header) = grep { $l[$_] =~ /^\x{e2}\x{95}\x{91} \Q$target\E\s*$/ } reverse 0 .. $#l;
      next unless defined $header;
      my $first = $header + 2; my $last = $first;
      $last++ while $last <= $#l && $l[$last] !~ /^\x{e2}\x{95}\x{ac}/;
      $last-- while $last > $first && $l[$last - 1] =~ /^\s*$/;
      push @blocks, [$target, $first, $last - 1];
    }
    if (!@blocks) { my $from = @l > $budget ? @l - $budget : 0; print "$_\n" for @l[$from .. $#l]; exit }
    my $each = int($budget / @blocks); $each = 20 if $each < 20;
    for (@blocks) {
      my ($target, $first, $last) = @$_;
      my $from = $last - $first + 1 > $each ? $last - $each + 1 : $first;
      print "--- $target (last ", $last - $from + 1, " lines)\n";
      print "$_\n" for @l[$from .. $last];
    }' "$1" 60
}

started=$SECONDS
status=0
failed=
run_step() {
  local label=$1 start=$SECONDS indent=
  shift
  printf '\n===== %s\n' "$label" >>"$work/log"
  QYL_VERBOSE=1 "$@" 2>&1 | plain | tee -a "$work/log" >"$work/step"
  status=${PIPESTATUS[0]}
  local word=PASS
  ((status == 0)) || word=FAIL
  if ((!single)); then
    printf '%s %6s  %s\n' "$word" "$(duration $((SECONDS - start)))" "$label"
    indent='     '
  fi
  fallout_rows "$work/step" | sed "s/^/$indent/"
  if ((status != 0)); then
    failed=$label
    failure_tail "$work/step"
  fi
}

if ((single)); then
  run_step "$*" "$@"
else
  for command in "$@"; do
    run_step "$command" bash -ec "$command"
    ((status == 0)) || break
  done
fi

if ((status == 0)); then
  printf 'PASS %s in %s, log %s\n' "$name" "$(duration $((SECONDS - started)))" "$log"
else
  printf 'FAIL %s in %s (exit %d: %s), log %s\n' "$name" "$(duration $((SECONDS - started)))" "$status" "$failed" "$log"
fi
exit "$status"
