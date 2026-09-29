# Restricted-empty seen-line provenance

## Problem

A host may persist different bytes from the edit preview. When no previously displayed line survives in the unchanged prefix, the resulting tag has no displayed anchors but may permit them. With a nonempty prior set and a first-line change, the current base instead panics; PR #103 fixes that separate range error. Live-tag enforcement is the scope here; stale-tag recovery is separate.

Evidence in this tree:

- `Session::apply` in `crates/pi-edit/src/session.rs` skips empty sets: `if !seen_lines.is_empty() { self.store.record_seen_lines(&key, tag, &seen_lines); }`.
- `carried_seen_lines` in the same file treats an empty prior set as unrestricted: `Some(seen) if !seen.is_empty() => seen.range(1..=unchanged).copied().collect()` followed by `_ => (1..=unchanged).collect()`. PR #103 adds a zero-prefix guard to the first arm.
- `assert_seen_lines` in `crates/pi-edit/src/modes/hashline/patcher.rs` skips an empty set: `if seen.is_empty() { return Ok(()); }`.

## Approach

Matt chose option A in RIG-4092. Keep `Snapshot.seen_lines: Option<BTreeSet<u32>>` in `crates/pi-edit/src/store.rs`: `None` means no recorded restriction; `Some(empty)` means no line is authorized. For tracked edits record even an empty carried set. In `carried_seen_lines`, propagate only members of a prior `Some(seen)`, including an empty set; a missing or `None` prior retains the unrestricted-prefix behavior. In `assert_seen_lines`, enforce every `Some(seen)` for live matching tags. Existing reveal/retry and explicit re-read flows authorize lines afterward.

A successful host-drifted edit does not authorize preview rows, because those rows describe bytes other than the tag's. No new snapshot type or error format is required: `merge_seen` in `crates/pi-edit/src/store.rs` already creates an empty set for an empty slice with `get_or_insert_with(BTreeSet::new).extend(lines.iter().copied())`.

`maybeWriteSnapshotHeader` in `packages/coding-agent/src/tools/write.ts` calls `recordSnapshot(absolutePath, normalized, [])` and says an anchored edit needs an inline reveal. But `docs/tools/write.md` promises a tag usable by the next edit without another read, and coding-agent tests expect immediate success. Enforcing `Some(empty)` would change this shipped behavior. RIG-4096 asks Matt whether write tags should be restricted-empty (and require reveal/retry) or remain unrestricted (`None`); freeze and dependent TS work wait on that choice.

**Same-content versions:** `EditStore::record` in `crates/pi-edit/src/store.rs` promotes an identical-text version, while `EditStore::record_seen_lines` finds that version by tag and merges the newly carried set with `merge_seen(..., Some(lines))`. A drifted write can thus restrict an older unrestricted `None` version. Nonempty carried sets already do this. The plan tests this exact merge path instead of creating another version with the same bytes.

## Global Constraints

- Keep the first-line range panic fix in PR #103 separate. Implementation must start from its merged code or append to a single linear stack on #103.
- A prior `Some(empty)` never gains unchanged-prefix authorization through another unanchored edit.
- Missing snapshots remain unrestricted. Non-drifted output also authorizes response rows; drifted output does not.
- Live-tag provenance does not claim to enforce stale-tag recovery. The latter remains out of scope.

## Plan

1. Add a failing Rust regression for host drift with an empty carried set. Include both a first-line rewrite (after #103) and a host rewrite beyond an unchanged prefix whose prior seen lines do not fall in that prefix (works at the current base). Assert the tag rejects an undisplayed anchor and the file stays unchanged. Check store state before a re-read, since the inline reveal itself can authorize the rejected line; test re-read and reveal/retry independently.
2. Add an unanchored edit on a restricted-empty snapshot, then assert an unchanged-prefix anchor still fails. Add a separate `None`-snapshot case that still permits an anchor. Check same-content promotion through `record_seen_lines`.
3. Record an empty carried set from `Session::apply`, preserve it in `carried_seen_lines`, and enforce it in `assert_seen_lines`. After RIG-4096, update write-tag consumer tests and `docs/tools/write.md` as its decision requires. Run affected Rust and TS checks plus a direct drifted-write smoke.

## Tasks

- [ ] Add red Rust tests for both drift shapes, unanchored follow-up, unrestricted snapshots, and same-content merge.
- [ ] Enforce restricted-empty in session, store recording, and live-tag patcher checks.
- [ ] Resolve RIG-4096; adjust write-tag tests and docs accordingly, then verify format, lint, tests, and direct smoke.
