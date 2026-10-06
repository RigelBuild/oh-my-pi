#!/usr/bin/env bash
# Usage: release-on-branch.sh <tag> — fails unless HEAD is on origin/rigel-release.
# A tag dispatch can name any commit; only what the gated branch holds may release.
set -euo pipefail
tag="$1"
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --quiet --unshallow origin rigel-release
else
  git fetch --quiet origin rigel-release
fi
if ! git merge-base --is-ancestor HEAD FETCH_HEAD; then
  echo "::error::$tag is not on rigel-release; refusing to release."
  exit 1
fi
