#!/usr/bin/env bash
# Tests for release-on-branch.sh in shallow and full clones of a scratch origin.
set -u
script="$(cd "$(dirname "$0")" && pwd)/release-on-branch.sh"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
fails=0
g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=rigel-release "$@"; }

g init -q "$dir/origin"
for m in c1 c2 c3; do g -C "$dir/origin" commit -q --allow-empty -m "$m"; done
g -C "$dir/origin" tag v1.0.0
base="$(g -C "$dir/origin" rev-parse HEAD~2)"
mirror="$(g -C "$dir/origin" commit-tree "$base^{tree}" -p "$base" -m mirror)"
g -C "$dir/origin" tag v9.9.9 "$mirror"

expect() {
  local name="$1" want_rc="$2" tag="$3" depth="$4" w rc
  w="$dir/w-$RANDOM"
  # shellcheck disable=SC2086
  g clone -q $depth --branch "$tag" "file://$dir/origin" "$w" 2>/dev/null
  (cd "$w" && "$script" "$tag" >/dev/null 2>&1)
  rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL $name: rc=$rc (want $want_rc)"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

expect "branch tag, shallow clone, releases" 0 v1.0.0 "--depth 1"
expect "branch tag, full clone, releases" 0 v1.0.0 ""
expect "mirror tag, shallow clone, refused" 1 v9.9.9 "--depth 1"
expect "mirror tag, full clone, refused" 1 v9.9.9 ""

[ "$fails" -eq 0 ]
