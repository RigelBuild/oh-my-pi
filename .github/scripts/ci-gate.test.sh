#!/usr/bin/env bash
# Tests for ci-gate.sh: the required `CI` fan-in.
set -u
script="$(dirname "$0")/ci-gate.sh"
fails=0

expect() {
  local name="$1" want_rc="$2" results="$3" skippable="$4" rc
  RESULTS="$results" PR_SKIPPABLE="$skippable" "$script" >/dev/null 2>&1
  rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL $name: rc=$rc (want $want_rc)"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

green='{"check":{"result":"success"},"rust_validate":{"result":"success"}}'
pr_skip='{"check":{"result":"success"},"rust_validate":{"result":"skipped"}}'
expect "all green passes" 0 "$green" ""
expect "failure fails" 1 '{"check":{"result":"failure"},"rust_validate":{"result":"success"}}' ""
expect "cancelled fails" 1 '{"check":{"result":"cancelled"},"rust_validate":{"result":"success"}}' ""
expect "PR-skippable job skipped on a PR passes" 0 "$pr_skip" "rust_validate native_addons_cross"
expect "same skip on push fails" 1 "$pr_skip" ""
expect "other job skipped on a PR fails" 1 '{"check":{"result":"skipped"},"rust_validate":{"result":"success"}}' "rust_validate native_addons_cross"
expect "PR-skippable job failing on a PR fails" 1 '{"check":{"result":"success"},"rust_validate":{"result":"failure"}}' "rust_validate native_addons_cross"

[ "$fails" -eq 0 ]
