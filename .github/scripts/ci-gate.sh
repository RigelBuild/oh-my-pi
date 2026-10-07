#!/usr/bin/env bash
# Fails unless every job in $RESULTS (toJSON(needs)) succeeded; jobs named in
# $PR_SKIPPABLE may also be skipped.
set -euo pipefail
failed="$(jq -r --arg skippable "${PR_SKIPPABLE:-}" '
  ($skippable | split(" ") | map(select(length > 0))) as $ok_skip
  | to_entries
  | map(select(.value.result != "success"
      and ((.value.result == "skipped" and (.key | IN($ok_skip[]))) | not)))
  | map("\(.key)=\(.value.result)") | join(", ")' <<<"$RESULTS")"
if [ -n "$failed" ]; then
  echo "::error::validation jobs not green: $failed"
  exit 1
fi
echo "all validation jobs green"
