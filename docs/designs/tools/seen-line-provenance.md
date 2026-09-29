# Restricted-empty seen-line provenance

## Problem

A host may persist different bytes from the edit preview. With no unchanged leading lines, the resulting tag has no displayed anchors but currently permits them. This affects live-tag enforcement; stale-tag recovery is separate.

Evidence in this tree:

- `Session::apply` in `crates/pi-edit/src/session.rs` skips empty sets: `if !seen_lines.is_empty() { self.store.record_seen_lines(&key, tag, &seen_lines); }`.
- `carried_seen_lines` in the same file treats an empty prior set as unrestricted: `Some(seen) if !seen.is_empty() && unchanged > 0` followed by `_ => (1..=unchanged).collect()`.
- `assert_seen_lines` in `crates/pi-edit/src/modes/hashline/patcher.rs` skips an empty set: `if seen.is_empty() { return Ok(()); }`.

## Approach

Matt chose option A in RIG-4092. Keep `Snapshot.seen_lines: Option<BTreeSet<u32>>` in `crates/pi-edit/src/store.rs`: `None` means no recorded restriction; `Some(empty)` means no line is authorized. For tracked edits record even an empty carried set. In `carried_seen_lines`, propagate only members of a prior `Some(seen)`, including an empty set; a missing or `None` prior retains the unrestricted-prefix behavior. In `assert_seen_lines`, enforce every `Some(seen)` for live matching tags. Existing reveal/retry and explicit re-read flows authorize lines afterward.

A successful host-drifted edit does not authorize preview rows, because those rows describe bytes other than the tag's. No new snapshot type or error format is required: `merge_seen` in `crates/pi-edit/src/store.rs` already creates an empty set for an empty slice with `get_or_insert_with(BTreeSet::new).extend(lines.iter().copied())`.

This also repairs the intended write-tool behavior. `maybeWriteSnapshotHeader` in `packages/coding-agent/src/tools/write.ts` calls `recordSnapshot(absolutePath, normalized, [])` and documents that an anchored edit should require an inline reveal. Today the empty-set bypass defeats that intent. Update any TS test asserting immediate anchored success against a write-returned tag to exercise rejection and reveal/retry instead.

**Same-content versions:** `EditStore::record` in `crates/pi-edit/src/store.rs` merges a recorded version on identical text: `merge_seen(&mut snapshot.snapshot, seen_lines)`. A drifted write can therefore restrict a previously unrestricted same-content version. That already happens for nonempty carried sets. This design keeps the existing union/merge behavior rather than adding another version with identical bytes; test it so the semantic cost is visible. If this same-content downgrade is unacceptable, a separate store policy decision is needed before changing the merge model.

## Global Constraints

- Keep the first-line range panic fix in PR #103 separate. Implementation must start from its merged code or append to a single linear stack on #103.
- A prior `Some(empty)` never gains unchanged-prefix authorization through another unanchored edit.
- Missing snapshots remain unrestricted. Non-drifted output also authorizes response rows; drifted output does not.
- Live-tag provenance does not claim to enforce stale-tag recovery. The latter remains out of scope.

## Plan

1. Add a failing Rust regression for host drift: the host replaces the first line, the new tag rejects an undisplayed anchor, and the file stays unchanged. Assert store state before a re-read because the inline reveal itself can authorize the rejected line. Exercise re-read recovery separately.
2. Add an unanchored edit on a restricted-empty snapshot, then assert an unchanged-prefix anchor still fails. Add a separate `None`-snapshot case that still permits an anchor. Check same-content merging explicitly.
3. Record an empty carried set from `Session::apply`, preserve it in `carried_seen_lines`, and enforce it in `assert_seen_lines`. Update coding-agent tests that use write-returned tags. Run affected Rust and TS checks plus a direct drifted-write smoke.

## Tasks

- [ ] Add red Rust tests for drift, unanchored follow-up, unrestricted snapshots, and same-content merge.
- [ ] Enforce restricted-empty in session, store recording, and live-tag patcher checks.
- [ ] Adjust write-tag consumer tests to assert reveal/retry, and verify format, lint, tests, and direct smoke.
