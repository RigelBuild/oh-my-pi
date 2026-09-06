# Fork overlay: single-branch fork maintenance + `-rigel.N` releases

Status: Draft (to be frozen on merge). Builds on the frozen
`docs/fork-resync.md` (PR #35); does not rewrite it. Where this record
contradicts that record's reconciliation note item 3 ("the `--match v*` globs
... need no change under the `-rigel.N` scheme"), THIS record supersedes: the
glob claim was wrong (evidence in the Approach), and Matt has since ruled the
two directions this record designs.

## Problem / Intent

The re-sync landed (fork `main` = `08e04cecbc` = upstream `v18.1.10`
(`ddde7db10a`) + 4 merged fork PRs #37/#38/#36/#34), but the remaining fork
machinery is scattered across separate held branches (release machinery,
memtools flake fix, /metrics), each rebased and PR'd independently, which
multiplies conflict resolution on every upstream re-sync. Matt ruled two
directions: (1) carry ALL fork-specific commits as ONE ordered long-lived
overlay branch, rebased as a unit and re-landed in a single PR per re-sync;
(2) fork releases use `<upstream-base>-rigel.<N>` (e.g. `18.1.10-rigel.1`),
which the release scripts currently reject. This record designs the HOW for
both. Strategic frame: the overlay is a cheap bridge that SHRINKS as commits
land upstream, until the fork needs no maintenance at all.

## Approach

### 1. The overlay model

**Definition.** The fork's entire divergence from upstream is the commit range
`<upstream-base>..origin/main` plus any not-yet-merged commits on one bookmark,
`fork/overlay` (name settled: D4). The bookmark is the staging tip of the fork delta;
`main` is always `upstream-base + fork delta`, nothing else. There are no other
long-lived fork branches; the held branches below are consumed into the overlay
and then deleted.

**Current fork delta already on main** (verified: `git log --oneline -8
origin/main` this session) — these 4 squash commits are NOT re-carried on the
bookmark; they are already part of the delta and get rebased with it at the
next re-sync:

| SHA | PR | Subject |
| --- | --- | --- |
| `9b3439d1a6` | #37 | fix(eval): stream one coalesced agent progress event |
| `3d79778a6b` | #38 | test(mcp): fix flaky GET-listener resume test |
| `c66d76c364` | #36 | ci: run release and main-event jobs on hosted runners |
| `08e04cecbc` | #34 | feat(coding-agent): add --reapply-config on resume |

**Ordered commit set the bookmark must carry today** (reconciled against
`jj bookmark list --all` and per-commit cherry-pick sims run this session:
`git merge-tree --write-tree --merge-base=<sha>^ origin/main <sha>`):

| # | Source | SHA | Subject | Sim onto main `08e04cecbc` |
| --- | --- | --- | --- | --- |
| 1a | fork-resync T3 (#20) | `6983e32e52` | feat(release): publish the npm closure under the @rigelbuild scope (RIG-2511) | sourced from live branch `upstream-omp/rig-2511-rigelbuild-npm-scope` (see reconciliation) |
| 1b | fork-resync T3 (#20 follow-up) | `8427aa4acf` | fix(release): skip private manifests in the rename collision guard (RIG-2511) | same live branch, carried immediately after 1a |
| 2 | fork-resync T3 (#22) | `d208a2e9ba` | fix(release): tagless first release (RIG-2777) | CLEAN (rc=0) |
| 3 | fork-resync T3 (#23) | `5287792c92` | refactor(release): in-process version rewrite, no `sd` | CONFLICT: `scripts/release.ts`, `scripts/release.test.ts` — rework, not cherry-pick |
| 4 | fork-resync T3 (#24) | `91737b1b3d` | fix(release): changelog diff floor on tagless release | CLEAN (rc=0) |
| 5 | fork-resync T3 (#27) | `1726adb5c5` | fix(release): CI-poll transient retry | CONFLICT: `scripts/release.test.ts` only — minor rework |
| 6 | fork-resync T4 | `f3ff9ee2bd` (`upstream-omp/rig-3227-resync-memtools`) | test(mnemopi): event-gate dispose-timeout test (#31) | CLEAN (rc=0); already rebased onto `ddde7db10a`, 1 commit ahead |
| 7 | fork-resync T5 | `9d55e0a600` (`upstream-omp/rig-3144-resync-metrics`) | feat(auth-broker): Prometheus /metrics (#8) | CLEAN (rc=0); already rebased onto `ddde7db10a`, 1 commit ahead |
| 8 | NEW (this record) | n/a | feat(release): `-rigel.N` version scheme (spec in §2) | new work |
| 9 | NEW (this record, D3) | n/a | feat(update): re-point `omp update` to the `@rigelbuild` fork scope + RigelBuild repo | new work (spec in §2, Task 2b) |
| 10 | RIG-3339 (PR #40) | `0598ac138f` (`supervisor/rig-3339-fable-51-cacheread`, 3 commits from `fdeeed6d73`) | fix(catalog): gate fable/mythos 5.1 cache-read to 0.25 + bundle rebake + parity guard | N/A — branch is based directly on `08e04cecbc`, applies without rebase |

Bookmark-name reconciliation (from `jj bookmark list --all` this session):

- **T3 @rigelbuild scope (rows 1a/1b):** use the LIVE branch
  `upstream-omp/rig-2511-rigelbuild-npm-scope` (present on origin and in
  local packed-refs), which carries `6983e32e52` (the real #20) and its
  separate follow-up `8427aa4acf` (private-manifest collision-guard fix), in
  that order. Do NOT use `83e08681fb`: that SHA exists only in jj's store and
  is superseded (`git merge-base --is-ancestor` reports it unrelated to
  `8427aa4acf`; patch-ids differ). WARNING: the same branch also carries the
  DROPPED RIG-2218 refresh-subsystem F-patches (#8/#10/#11/#14/#15/#16/#17)
  and #7 as ancestors; per `docs/fork-resync.md` those stay dropped, so carry
  ONLY the two @rigelbuild release commits.
- **T4 memtools:** use `upstream-omp/rig-3227-resync-memtools` (`f3ff9ee2bd`,
  based on `ddde7db10a`, 1 ahead of the base). Do NOT use
  `upstream-omp/rig-3144-flaky-dispose-test` (`8d2ec5d9`): it sits on the OLD
  base `160ed439ac` with 19 commits ahead of main's history — same content
  (its tip cherry-picks clean), but the rebased single-commit variant is the
  correct source.
- **T5 metrics:** use `upstream-omp/rig-3144-resync-metrics` (`9d55e0a600`,
  based on `ddde7db10a`, 1 ahead, sim CLEAN). Do NOT use
  `upstream-omp/rig-2218-t2-f1-authbroker-metrics` (`922af45d`, old base,
  sim conflicts in `eval-code-mode-declarations.test.ts`) or
  `omp-authbroker-metrics` (`9cb92019`, 9 ahead of an even older base; it is
  the HEAD of upstream PR can1357/oh-my-pi#10290 and stays untouched for that
  purpose).
- **Row 10 fable/mythos cache-read (RIG-3339):** this row exists because the
  defect is UPSTREAM's, not the fork's, which is exactly what makes a
  main-only fix unsafe. Verified this session:
  `packages/catalog/src/compat/rules/classes/anthropic.kdl` is the SAME GIT
  BLOB (`eb2920ed34bbb8ef400e8db4748e08c6109eb521`) at fork main
  `08e04cecbc` and at `upstream/main` `b2f25dbfe1e3` — the fork never
  diverged here, it inherited the unconditional `cache-read 1.0` on the
  `fable` (`:141-145`) and `mythos` (`:153-157`) families verbatim. A reset
  sets main to the upstream tip, and the upstream tip still carries that
  blob, so a fix landed only as a commit on main is DETERMINISTICALLY
  reverted by the next reset — silently: no conflict, no test red, just a
  restored 4x cache-read overbill. That is the precise failure class this
  overlay exists to prevent, so the fix is carried as an overlay row rather
  than left as a one-off main commit.
  - The fix must restate ALL FOUR cost fields (input 10.0, output 50.0,
    cache-read 0.25, cache-write 12.5) in the `revision ">=5.1"` block:
    `cost-patch` is ONE cascade axis and object axes REPLACE rather than
    merge (`contest()` keeps a single winner per axis), so a cache-read-only
    block resolves to `{cacheRead: 0.25}` alone and silently drops the other
    three to upstream values — worse than the original bug, and green under
    a naive cacheRead-only check.
  - Both families are affected; a fable-only fix leaves half the overbill
    live. No `AmbiguousOverlapError` risk: revision-constrained rules score
    `dimensions=4` vs `3` for the bare-family block, and `rankCompare` is
    `exactness || dimensions || priority`, so the ranking is unambiguous.
  - **The fix is THREE commits and the overlay carries all three.** A KDL
    change alone is NOT sufficient, because two different code paths read the
    cost and only one of them goes through the cascade:
    - `fdeeed6d73` — the KDL `revision ">=5.1"` blocks on both families, plus
      the `gen:compat` recompile of `rules.json`. This fixes the RUNTIME path
      (`buildModel` → `applyCatalogCorrections`).
    - `7e01125f5b` — **rebake `models.json` (REQUIRED, not a duplicate of the
      above).** `getBundledModel` (`packages/catalog/src/models.ts:38-41`)
      returns the bundled row VERBATIM with no `buildModel` call (rows are
      pre-baked to keep startup allocation-free), and
      `packages/stats/src/db.ts:346-352` prices from exactly that row. So the
      KDL fix alone leaves the stats/cost-reporting path billing 4x — the
      same silent failure this row exists to prevent, with no conflict and no
      test red.
    - `0598ac138f` — the bake/rule cost-parity guard in
      `compat-parity.test.ts`. This is the ONLY automated detector of a stale
      bundle: neither `gen:models` nor `gen:compat` runs in CI, so without it
      a future rule change silently desynchronizes from the bake.
  - Narrow scope note on generated output: patching
    `generated-policies.ts` is the no-op to avoid — `buildModel` applies
    `costPatch` at RUNTIME (`packages/catalog/src/build.ts:113-124`), so a
    corrected spec is overwritten back to `1` by the KDL rule. Rebaking
    `models.json` from the corrected rules is a different thing and is
    REQUIRED, per the commit above. "Do not patch the policy generator" does
    not mean "do not touch generated output".
  - **Lifecycle:** the permanent home is upstream (their bug, their file),
    but no agent can push to `can1357` — it is not in the push-guard owner
    allowlist (`push-guard/index.ts` `ALLOWED_OWNERS`) — so it ships via the
    human-action upstream-PR queue. When upstream takes it, row 10 drops as
    redundant — the same
    lifecycle as row 7 (/metrics) against `can1357#10290`.
- **T3 release machinery (rows 2-5):** no live rebased bookmark exists (the
  four SHAs #22/#23/#24/#27 sit on the old base `160ed439ac`); the overlay
  construction cherry-picks/reworks them directly, in the order above (#22
  before the `-rigel.N` commit — the glob change in §2 makes the
  first-release path tagless, which #22 handles).
- **Double-carry guard:** none of the rows above is an ancestor of
  `origin/main` (verified per-branch with `git merge-base --is-ancestor`; all
  reported `not-on-main`). `scripts/rigel-scope-rename.ts` is absent from
  `origin/main` (verified `git cat-file -e`), confirming the release machinery
  is not already landed.

**Re-sync runbook (recurring, composes with `docs/fork-resync.md`).** The
frozen fork-resync record governed the ONE-TIME reset + curated re-lay; its
Task-1 runbook is spent. This is the steady-state loop that replaces per-branch
re-lay from here on:

1. `git fetch upstream` and pick the new base: the upstream release tag to sit
   on (normally the latest `vX.Y.Z` on `upstream/main`).
2. Materialize the overlay onto the new base. The delta commits and
   `origin/main` are immutable under jj's default `immutable_heads()`, so a
   plain `jj rebase -s <first-delta-commit> -d <new-base>` errors. Two
   mechanisms exist: `jj rebase ... --ignore-immutable` (rewrites in place
   and drags local `main` along) or a `jj duplicate`-based re-materialization
   (`jj duplicate <old-base>..main -d <new-base>`, then point a fresh
   `fork/overlay` bookmark at the duplicated tip). Use the DUPLICATE form:
   it leaves local `main` untouched until Matt's step-4 admin reset, so step
   5 starts from a defined state (local `main` still on the old base, the
   new delta living only on the bookmark). Resolve conflicts ONCE, here.
   Drop any commit now redundant with upstream (shrinkage, below).
3. Verify on the overlay tip: `bun install`, `bun run ci:check:full`, and the
   suites the carried commits own (release, scope-rename, memory-tools,
   auth-broker).
4. Matt resets `origin/main` to the new base (HUMAN-ACTION, same
   admin-API mechanism as fork-resync Task 1:
   `gh api -X PATCH repos/RigelBuild/oh-my-pi/git/refs/heads/main -f sha=<new-base> -F force=true`;
   agents never force-push main).
   Tag disposition across the reset: prior `v*-rigel.*` tags are RETAINED but
   become orphaned (they point at commits on the abandoned pre-reset history,
   since `release.ts:430` pushed them to origin). Retention is safe and is the
   same mechanism the tagless path relies on: `git describe` only considers
   ANCESTORS, so an orphaned tag can never be selected as `latestTag`, and the
   per-base `N`-resets-to-1 rule means the next lineage mints a fresh name
   (`v18.1.11-rigel.1`) that cannot collide with a retained one. One caveat to
   watch: `ci.yml:139`'s release detector matches ANY v-prefixed tag at HEAD
   (`git tag --points-at HEAD | grep -E '^v[0-9]'`), so if a retained tag ever
   lands on a re-created commit it would trigger a spurious release run; delete
   an orphaned tag if that ever happens rather than pre-emptively pruning.
5. One PR: `jj-vine submit fork/overlay` back onto the reset main. Review
   fixes are additive commits on the bookmark (never amend+force-push while
   the PR is open). Merge; delete nothing — the bookmark stays and tracks the
   delta for the next cycle.
6. First release on the new base is `<new-base-version>-rigel.1` (Matt,
   manual).

**Shrinkage protocol (the stop-maintaining-the-fork goal).** Every overlay
commit is a candidate for an upstream PR. When one merges upstream, it is
dropped from the overlay at the NEXT re-sync rebase (step 2: `jj abandon` the
now-redundant commit), exactly as fork-resync dropped #7 after upstream
`7bf5230c0d`. Live example: the /metrics commit (row 7) is already proposed
upstream as can1357/oh-my-pi#10290 (head `omp-authbroker-metrics`); when it
merges, row 7 drops. The overlay's commit list IS the fork's outstanding
upstream-work queue — `git log --oneline <upstream-base>..origin/main`
enumerates it with zero bookkeeping.

**jj-vine coexistence.** The overlay is one long-lived bookmark, not a stacked
chain: submit is always `jj-vine submit fork/overlay` (one PR), review fixes
are additive commits per `skill://jj`, and the PR is promoted from draft with
`gh pr ready` after review. Rewriting overlay commits (squashing review fixups
into their logical commit, dropping upstreamed commits, reordering) happens
ONLY during a re-sync rebase (step 2), when no PR is open on the bookmark —
the never-amend-a-pushed-head rule binds while a PR is open, and the re-sync
rebase is by definition a fresh materialization after the previous PR merged.

### 2. The `-rigel.N` release scheme

**Grammar.** Fork version = `<base>-rigel.<N>`; `<base>` = the upstream
version the fork currently sits on (today `18.1.10`, verified
`packages/coding-agent/package.json` `"version": "18.1.10"`); `N` = positive
integer, starts at 1 per base, increments per fork release, resets to 1 when a
re-sync advances the base. Git tag = `v<base>-rigel.<N>` (e.g.
`v18.1.10-rigel.1`). npm publishes under the `@rigelbuild` scope (overlay
rows 1a/1b), so npm versions never collide with upstream's `@oh-my-pi` scope;
the git TAG namespace is the collision surface, handled below.

**Why `compareVersions` needs NO change.** `packages/utils/src/version.ts:11-12`:

> ```text
> a SemVer-2.0 prerelease suffix sorts before the plain release
> (`1.0.0-beta` < `1.0.0`); prerelease identifiers follow SemVer order
> ```

So `18.1.10-rigel.1 < 18.1.10 < 18.1.11`: against an UPSTREAM tag the
monotonic guard fail-closes on every fork release. But WITHIN the rigel
lineage the ordering is exactly right: `18.1.10-rigel.2 > 18.1.10-rigel.1`
(numeric prerelease identifier compare) and `18.1.12-rigel.1 >
18.1.10-rigel.5` (core segments win first). The fix is therefore not in the
comparator — it is in WHICH tag the script compares against. The base only
advances at re-sync, so comparing rigel-tag-to-rigel-tag is always correct.

**The tag-lineage isolation (the load-bearing edit).** `scripts/release.ts:265`:

> ```ts
> const latestTag = (await git(["describe", "--tags", "--abbrev=0", "--match", "v*"]).text()).trim();
> ```

`v*` matches upstream's tags: the clone holds upstream `v18.1.11` today
(verified `git tag -l 'v18.1.*'`), and `git describe ... origin/main` resolves
`v18.1.10` — an upstream tag that is an ancestor of fork main by construction
after every re-sync. With it, `scripts/release.ts:275`:

> ```ts
> if (compareVersions(version, latestTag) <= 0) {
> ```

rejects `18.1.10-rigel.1` vs `v18.1.10` (prerelease sorts below). **Change the
match glob to `--match "v*-rigel.*"`** so `latestTag` is drawn from the fork's
own lineage only. On a fresh base no such tag is reachable, and the
tagless-first-release path from overlay row 2 (#22, `d208a2e9ba`
"fix(release): support the first release on a tagless fork") handles it,
which is why #22 orders BEFORE the `-rigel.N` commit. #22's actual mechanism
(verified from its diff this session) is what makes the composition safe: it
resolves `git describe` through `.nothrow()` to an empty string on a tagless
repo (its comment: "git describe exits non-zero when the repo has no v* tag
yet", mirroring fix-changelogs' `gitMaybe`), and extracts a pure exported
`resolveReleaseVersion(versionOrBump, latestTag)` with an explicit
first-release branch: the `compareVersions` monotonic guard only runs
`if (latestTag)`, so an explicit version releases with no prior tag. The real
invariant is stronger than "first release ever": the tagless path runs after
EVERY re-sync, because every prior `v*-rigel.*` tag sits on the pre-reset
history and is a non-ancestor of the force-reset main, hence
un-describable; the tolerance in #22 is load-bearing on every cycle, not
once. The same glob fix applies to `scripts/fix-changelogs.ts:806`:

> ```ts
> return ((await gitMaybe(["describe", "--tags", "--abbrev=0", "--match", "v*"], repoRoot)) ?? "").trim();
> ```

whose tagless case overlay row 4 (#24, changelog diff floor skip) already
covers. This supersedes fork-resync reconciliation note item 3's claim that
the `--match v*` globs "need no change": the collision is not tag-NAME
collision but tag-SELECTION — `v*` selects upstream's release tags as the
comparison baseline.

**`validateExplicitVersion` (`scripts/release.ts:33-36`).** Current:

> ```ts
> const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(version);
> ```

rejects any prerelease suffix (called from both the CLI dispatch at `:476` and
`cmdRelease` at `:234`). Change to accept and REQUIRE the fork suffix:

> ```ts
> /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rigel\.[1-9]\d*)$/
> ```

Requiring (not merely allowing) the suffix makes a bare `18.1.11` release
impossible on the fork: it would mint tag `v18.1.11` colliding with upstream's
existing `v18.1.11` and publish an upstream-shaped version from fork code.
The function's doc comment (release.ts:19-32) is rewritten: the "prereleases
are rejected" rationale inverts for `-rigel.N`, which IS the fork's stable
channel (see dist-tag below). Error text at `:237` updates to name the
expected shape (`18.1.10-rigel.1`).

**`parseVersion` + bump keywords (`scripts/release.ts:191-219`).**
`parseVersion` (`:192`) matches `/^(\d+)\.(\d+)\.(\d+)(?:-canary\.\d+)?$/` and
throws on `-rigel.N`; it gains `(?:-(?:canary|rigel)\.\d+)?`. The bump
keywords `major`/`minor`/`patch` bump the BASE, which on the fork only a
re-sync may do, and `canary` (`bumpCanaryVersion`, `:212-219`) mints
`-canary.N` in upstream's dist-tag channel — all four are refused in
`cmdRelease` with an error pointing at the `rigel` keyword. A new `rigel`
bump keyword is added (D5): if `latestTag` matches
`-rigel.(\d+)$`, increment `N`; if the lineage is tagless (fresh base), read
the base from `packages/coding-agent/package.json` and mint `<base>-rigel.1`.
Explicit `18.1.10-rigel.N` remains accepted alongside it.

**`npmDistTag` (`scripts/ci-release-publish.ts:139-145`).** Current:

> ```ts
> if (/^\d+\.\d+\.\d+-canary\./.test(version)) return "canary";
> if (/^\d+\.\d+\.\d+-/.test(version)) {
>     throw new Error(`Unsupported prerelease version for npm publish: ${version}`);
> }
> return "latest";
> ```

`-rigel.N` currently throws. Add
`if (/^\d+\.\d+\.\d+-rigel\.\d+$/.test(version)) return "latest";` before the
catch-all throw: `-rigel.N` is the fork's STABLE channel, not a prerelease
channel, and `@rigelbuild` consumers install via the `latest` dist-tag /
`omp update`'s `/latest` endpoint (settled by D2 + D3).

**Sentinel: one fix needed (install-test harness only).** The tag-side
sentinel is fine: `scripts/release.ts:345`
`const sentinelJsId = version.replace(/[^A-Za-z0-9]/g, "_");` yields
`18_1_10_rigel_1`, a valid JS identifier fragment, and the RUNTIME loader is
already tolerant (`packages/natives/native/loader-state.js:667,698` match the
permissive `/^__piNativesV[A-Za-z0-9_]+$/`). But the install-test harness is
NOT: `scripts/install-tests/native-version.ts:3` pins
`/^__piNativesV(\d+)_(\d+)_(\d+)$/` (anchored, exactly three numeric
segments), so `__piNativesV18_1_10_rigel_1` does not match,
`nativeVersionFromExports` returns undefined, and the CLI throws "Native
addon has no unique release version sentinel" (`native-version.ts:20`),
failing `ci:test:install-methods` (`package.json:124`, `ci.yml:545`) on the
first rigel release commit and blocking the release. Fix in Task 2: the
harness must round-trip the FULL version, suffix included. Widening
`VERSION_SENTINEL_RE` is NECESSARY BUT NOT SUFFICIENT: `native-version.ts:10`
rebuilds the version from only the first three groups
(``.map(match => `${match[1]}.${match[2]}.${match[3]}`)``), so a widened regex
alone silently drops the capture and yields the TRUNCATED `18.1.10`. That
truncation fails a second time, further downstream and with a misleading
diagnosis: `run-ci.sh:67` feeds the value to `align_native_manifest`, whose
`:78-82` comparison sees `declared_version 18.1.10-rigel.1` !=
`addon_version 18.1.10` and REWRITES `packages/natives/package.json` down to
`18.1.10`; `loader-state.js:840` then derives `__piNativesV18_1_10`, which the
addon does not export, so `validateLoadedBindings` (`:685-728`) fails the
strict path. Worse, the `:706` `diskHasExpectedSentinel` check uses
`.includes()` on the raw file bytes and `__piNativesV18_1_10` IS a substring of
`__piNativesV18_1_10_rigel_1`, so it evaluates TRUE and routes into the
`:714` branch that throws the wrong error ("omp was upgraded while this
session was running; restart omp") instead of a version mismatch.

PRESCRIBED fix (both edits in the same commit): widen `VERSION_SENTINEL_RE`
(`:3`) to `/^__piNativesV(\d+)_(\d+)_(\d+)(?:_rigel_(\d+))?$/` AND fix the
`:10` rebuild to
`` .map(m => `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-rigel.${m[4]}` : ""}`) ``.
Verified: the rigel sentinel then yields `18.1.10-rigel.1` and a plain
three-segment sentinel still yields `18.1.10`, so the existing
`native-version.test.ts` cases and the PR path both keep passing.

Two mechanisms that look plausible and are WRONG, recorded so nobody retries
them:

- **Blind `_`-to-`.` inversion**
  (`sentinel.slice("__piNativesV".length).replace(/_/g, ".")`) yields
  `18.1.10.rigel.1`, not `18.1.10-rigel.1`. The encoding at `release.ts:345`
  (`version.replace(/[^A-Za-z0-9]/g, "_")`) is LOSSY: it maps both `.` and `-`
  to `_`, so a blind inverse cannot recover which separator was which.
- **Deriving the expected sentinel from `packages/natives/package.json`** (the
  way `loader-state.js:840` does) inverts the harness's direction of use and
  breaks the PR path. `run-ci.sh:67` calls this helper to discover what the
  addon ON DISK actually is, precisely so `align_native_manifest` (`:76-82`)
  can reconcile a DIVERGENT manifest against it; deriving the answer from the
  manifest returns `undefined` in exactly that divergent case. Concretely:
  `ci.yml:282-285` deliberately fetches the UPSTREAM base addon
  (`base="${version%%-*}"` → `@oh-my-pi/pi-natives-linux-x64@18.1.10`,
  exporting `__piNativesV18_1_10`) while the checkout's manifest carries
  `18.1.10-rigel.1`, so manifest-derivation would fail
  `ci:test:install-methods` red on every post-first-release PR.

Only this harness needs the change.

**GitHub release notes: a second regex needs the suffix (Task 4 scope).** Two
`-rigel.N`-blind regexes sit in `scripts/ci-release-notes.ts`, and the second
one is the consequential one:

- `:223` filters the release list with `/^v\d+\.\d+\.\d+$/`, excluding
  `v*-rigel.*`, so `resolveFloor` stays in single-version mode (the silent-tag
  changelog roll-forward is disabled). Low impact on its own.
- `:66` `enumerateChangelogVersions` matches headings with
  `/^## \[(\d+\.\d+\.\d+)\]/` (three bare numeric segments, no prerelease). But
  `release.ts:169` writes the heading as ``` `## [${version}] - ${date}` ``` =
  `## [18.1.10-rigel.1] - <date>`, which that regex does NOT match (verified).
  So every package yields an empty section, `main()` takes the
  `sections.length === 0` branch (`:265-269`), and an EMPTY `release-notes.md`
  is written. `ci.yml:885` feeds that file to the `softprops/action-gh-release`
  step (`:906-910`) as the release body, so **every fork GitHub release would
  ship with no notes.**

The release does not FAIL either way, but empty notes on every release is not
an acceptable steady state, and widening `:66` (plus `:223`) to accept the
optional `-rigel.N` suffix is a two-regex change. Fold both into Task 4
alongside the `npmDistTag` mapping, with T6 coverage asserting a
`## [18.1.10-rigel.1]` heading is enumerated and its section renders non-empty.

**No-change-needed spots (verified this session):**

- Tag ref (`scripts/release.ts:427`): ``const tagRef = `v${version}`;`` →
  `v18.1.10-rigel.1`. No change (the retry instructions at `:446-448`
  interpolate the same way).
- CI natives fetch (`.github/workflows/ci.yml:282-285`) already strips the
  suffix: `base="${version%%-*}"` fetching
  `@oh-my-pi/pi-natives-linux-x64@${base}`. No change now; the planned flip to
  `@rigelbuild` after the first fork native release (fork-resync
  reconciliation note 2) is Plan task T5.

**Who runs the release.** `scripts/release.ts:430`:

> ```ts
> await git(["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `${sha}:refs/tags/${tagRef}`]);
> ```

pushes directly to `main`. Agents never do this: every `bun scripts/release.ts
...` invocation is Matt's manual action (per fork-resync Global Constraints
and `rule://commit-conventions`), handed off via a `human-action` Linear issue.

## Alternatives considered

### Keep N held branches, PR each per re-sync (status quo; rejected)

Every re-sync pays a per-branch rebase + PR + review + CI cycle (fork-resync
Tasks 3/4/5 were three PRs for what is one logical delta), and nothing
enumerates the fork's divergence in one place. Matt explicitly rejected this
("the problem right now is that we have everything in like 3 different
branches").

### Merge-based fork (merge upstream into main; rejected)

Already rejected in `docs/fork-resync.md` Alternatives: carries conflict
resolution forward into every future merge and buries the fork delta inside
merge history, killing the `git log <base>..main` = outstanding-upstream-work
property the overlay depends on.

### Patch-file overlay (quilt/stgit-style patches in-repo; rejected)

Turns every upstream conflict into a fuzzy patch failure with no
jj/git-native 3-way merge, and puts the delta outside code review. jj's
first-class rebase of a commit range gives the same "ordered patch series"
semantics with real merge machinery.

### Dedicated `rigel` npm dist-tag instead of `latest` (rejected; see D2)

Publishing `-rigel.N` under a `rigel` dist-tag would keep `latest` unclaimed,
but the `@rigelbuild` scope is fork-only — there is no upstream `latest` to
protect — and `omp update` reads the `/latest` endpoint (per the
`validateExplicitVersion` doc comment, `scripts/release.ts:22-25`), so a
non-`latest` tag breaks self-update for fork installs. Recommendation stays
`latest`; Matt ruled `latest` (D2) as the fork's stable publish channel.

## Global Constraints

- **Version scheme is settled:** `<upstream-base>-rigel.<N>`, tag
  `v<base>-rigel.<N>`, `N` starts at 1 per base and resets on re-sync. This
  supersedes fork-resync OQ1's recommendation (d) (`rigel-v*` prefix); Matt
  ruled the suffix form. Do not relitigate.
- **The fork's release scripts accept ONLY `-rigel.N` explicit versions**
  (plus the `rigel` bump keyword, D5). Bare `X.Y.Z`, `major`,
  `minor`, `patch`, and `canary` are refused on the fork: each would mint a
  tag or dist-tag in upstream's namespace.
- **Agents never release and never force-push main.** `bun scripts/release.ts`
  pushes to `main` directly (`scripts/release.ts:430`) — every release run and
  every re-sync main reset is Matt's manual action, handed off per
  `skill://human-action-handoff`. Everything else lands via `jj-vine submit`
  PRs.
- **One overlay bookmark.** No new long-lived fork branches; new fork work
  merges to main via its own PR and thereby joins the delta, or lands as an
  overlay commit when the overlay PR is in flight. The consumed source
  branches (`upstream-omp/rig-3227-resync-memtools`,
  `upstream-omp/rig-3144-resync-metrics`, the stale T3/T4/T5 variants) are
  deleted after the overlay PR merges — EXCEPT `omp-authbroker-metrics`,
  which is the head of upstream PR can1357/oh-my-pi#10290 and must stay until
  that PR closes.
- **Additive review fixes.** While an overlay PR is open, fixes are new
  commits on the bookmark; history rewriting (fixup squash, drop, reorder)
  happens only during the re-sync rebase with no PR open.
- **Commit identity + prose:** author `mattwilki17@gmail.com`, committer
  mintaka, `Co-authored-by` trailer, Conventional Commits subjects, zero
  em-dashes in outbound prose (PR bodies, issue comments) per
  `rule://de-ai-public-prose`.
- **Red-green on release-script semantics:** every behavioral change in T2-T4
  lands with a failing-first test in `scripts/release.test.ts` /
  `scripts/ci-release-publish` coverage (see T6).

## Plan

### Task 1: Construct the overlay bookmark

Build `fork/overlay` (D4) on top of `main@origin` (`08e04cecbc`)
in a dedicated jj workspace, as the 11 existing source commits in the Approach
table's order (table rows 1a-7 plus row 10's three commits; rows 1a-7 are 8
commits since row 1 splits into 1a/1b; rows 8-9 are Tasks 2-4/2b's output,
not Task 1's):

1. Cherry-pick `6983e32e52` (#20) then `8427aa4acf` (its private-manifest
   collision-guard follow-up), both from
   `upstream-omp/rig-2511-rigelbuild-npm-scope`, NOT `83e08681fb` (jj-store
   only, superseded; see reconciliation). Carry ONLY these two commits from
   that branch; its RIG-2218 refresh ancestors stay dropped.
2. Cherry-pick `d208a2e9ba` (#22, sim clean).
3. Rework `5287792c92` (#23): sim conflicts in `scripts/release.ts` +
   `scripts/release.test.ts`; re-express the in-process replacements for the
   three `sd` shell-outs (`scripts/release.ts:296`, `:315`, `:352` on current
   main) against the current script shape.
4. Cherry-pick `91737b1b3d` (#24, sim clean).
5. Rework `1726adb5c5` (#27): sim conflicts in `scripts/release.test.ts` only;
   `watchCI` (`scripts/release.ts:46`) is still a bare poll on main.
6. Cherry-pick `f3ff9ee2bd` (memtools, sim clean) from
   `upstream-omp/rig-3227-resync-memtools`.
7. Cherry-pick `9d55e0a600` (/metrics, sim clean) from
   `upstream-omp/rig-3144-resync-metrics`; re-run its four suites (named in
   fork-resync Task 5) since the auth-broker context is now v18.1.10.
8. Cherry-pick row 10's three RIG-3339 commits in order — `fdeeed6d73` (KDL
   `revision ">=5.1"` + `gen:compat` recompile), `7e01125f5b` (rebake
   `models.json` + bake/rule parity guard), `0598ac138f` (parity-guard
   documentation) — from `supervisor/rig-3339-fable-51-cacheread`. That
   branch is based directly on `08e04cecbc`, so all three apply without
   rebase. All three are REQUIRED: the KDL fixes the runtime path and the
   rebake fixes the verbatim bundled-row path that `packages/stats` prices
   from (see the row-10 note in §1). Re-run `bun test packages/catalog`.

Sim status for rows 1a/1b is re-established here (the recorded sims ran
against the superseded SHA); a conflict means rework in place, same as steps
3 and 5.
No pushes to main; the bookmark is submitted in Task 5.
Interfaces: consumes the 11 source SHAs + `origin/main`; produces the ordered
`fork/overlay` bookmark. Verify at the bookmark tip: `bun run ci:check:full`
(lint + typecheck only — it resolves to `check:ts`, so it runs NO tests) PLUS
the carried suites: `bun test scripts/release.test.ts`, `bun test packages/catalog`, and the memtools +
auth-broker suites named in fork-resync Task 5.
Depends on: none (D4 fixes the name `fork/overlay`).

### Task 2: `-rigel.N` version acceptance in `scripts/release.ts`

One commit atop Task 1 (overlay row 8, part 1):

- `validateExplicitVersion` (`:33-36`): new regex
  `/^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rigel\.[1-9]\d*)$/`;
  rewrite the doc comment (`:19-32`) for the inverted rationale; update the
  error text at `:237` and the usage strings (`:463-465`, `:481-483`).
- `parseVersion` (`:191-195`): accept `(?:-(?:canary|rigel)\.\d+)?`.
- `cmdRelease` (`:228-242`): refuse `major`/`minor`/`patch`/`canary` with an
  error naming the `rigel` keyword and the explicit form.
- Add `bumpRigelVersion(latestTag, fallbackBase)` implementing the `rigel`
  bump keyword (D5): `-rigel.(\d+)$` present → increment `N`; tagless (fresh
  base) → read the base from `packages/coding-agent/package.json` and mint
  `<base>-rigel.1`.
- Fix the install-test sentinel round-trip:
  `scripts/install-tests/native-version.ts` must return the FULL version
  including the `-rigel.N` suffix, which takes TWO edits in the same commit:
  widen `VERSION_SENTINEL_RE` (`:3`) to
  `/^__piNativesV(\d+)_(\d+)_(\d+)(?:_rigel_(\d+))?$/` AND fix the `:10`
  rebuild to
  `` .map(m => `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-rigel.${m[4]}` : ""}`) ``.
  Widening the regex alone is NOT sufficient (`:10` rebuilds from groups 1-3,
  dropping the capture, truncating to `18.1.10` and failing downstream with a
  misleading diagnosis). Do NOT derive the version from
  `packages/natives/package.json` and do NOT use a blind `_`-to-`.` inverse:
  both are wrong for reasons recorded in Approach §2 (direction-of-use
  inversion that red-gates every post-release PR, and a lossy encoding that
  cannot recover the hyphen). The
  runtime loader is already tolerant (`loader-state.js:667,698`); only this
  harness blocks. Without the fix, `nativeVersionFromExports` returns
  undefined, the CLI throws at `native-version.ts:20`, and
  `ci:test:install-methods` (`package.json:124`, `ci.yml:545`) fails on the
  first rigel release commit.

Interfaces: consumes/produces `scripts/release.ts` exports
`validateExplicitVersion`, `parseVersion`, `bumpVersion`,
`bumpCanaryVersion` (+ new `bumpRigelVersion`), and
`scripts/install-tests/native-version.ts` `nativeVersionFromExports`; consumed
by Task 6 tests and the CLI dispatch (`:459-486`). Verify: red-green in Task 6.
Note the smoke `bun scripts/release.ts 18.1.10` refuses at the CLI DISPATCH
(`:476` returns null → the `else` at `:479-483`), so it never reaches
`cmdRelease`'s rewritten error text at `:237`; cover that path with a T6 unit
assertion instead of relying on the smoke.
Depends on: Task 1 step 3 (the #23 rework touches the same lines).

### Task 2b: Re-point `omp update` to the fork (D3, overlay row 9)

One commit atop Task 2. Rewrite the hard-pinned upstream constants in
`packages/coding-agent/src/cli/update-cli.ts` so a fork-installed `omp update`
resolves the fork, not upstream:

- `REPO = "can1357/oh-my-pi"` (`:26`) -> `"RigelBuild/oh-my-pi"` (GitHub
  release-metadata + binary-asset source, `getReleaseBinaryAsset`).
- `PACKAGE = "@oh-my-pi/pi-coding-agent"` (`:27`) -> `"@rigelbuild/omp-coding-agent"`
  (the scope-rename target: strip `pi-`, re-prefix `@rigelbuild/omp-`, per
  `rigel-scope-rename.ts`).
- `NATIVES_PACKAGE = "@oh-my-pi/pi-natives"` (`:53`) ->
  `"@rigelbuild/omp-natives"` (same rule).
- `HOMEBREW_FORMULA` / `MISE_TOOL` (`:28-29`): re-point to the fork's tap /
  `github:RigelBuild/oh-my-pi` if those install channels are supported;
  otherwise leave with a comment that the fork does not publish them (D3
  covers npm + GitHub-release self-update, the channels fork installs use).
- The published-tarball rename (`rigel-scope-rename.ts`) already rewrites the
  package NAMES at publish; this task aligns the source-of-truth constants the
  running binary reads so the two agree. The mapping is fixed by
  `renameSegment` (strip a leading `pi-`/`omp-`, re-prefix `@rigelbuild/omp-`):
  `@oh-my-pi/pi-coding-agent` -> `@rigelbuild/omp-coding-agent` and
  `@oh-my-pi/pi-natives` -> `@rigelbuild/omp-natives`. Those are the
  authoritative literals; anywhere else in this record naming a bare
  `@rigelbuild/omp` is wrong (Task 7's verify command is corrected to match).
  T6 pins `renamePackageName(PACKAGE)` equal to the new `PACKAGE` constant so
  the two can never drift silently.
- **Update the existing tests that hard-assert the upstream literals.** This is
  the task's real blast radius: 41 assertions across two files pin the current
  values, and every one fails the moment the constants move.
  `packages/coding-agent/test/update-cli.test.ts` (33 hits) includes
  `:429-430` `buildHomebrewUpdateArgs(false)` toEqual
  `["upgrade", "can1357/tap/omp"]`, `:434-435` `buildMiseUpgradeArgs()` toEqual
  `["upgrade", "github:can1357/oh-my-pi", "--bump"]`, `:443-445`
  `buildNpmInstallArgs` toContain `@oh-my-pi/pi-coding-agent@…`, and `:486-499`
  `buildRenameCleanupPackages` toEqual lists derived from the constants
  (`update-cli.ts:1420-1425`).
  `packages/coding-agent/test/cli/update-cli.test.ts` (8 hits) includes
  `:60-98` `stubRegistry` manifest keys and `:72`/`:83` asserting the exact URL
  `https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest`. All run in the
  coding-agent CI buckets (`scripts/ci-test-ts.ts:336-338`, `ci.yml`
  `test_coding_agent_*`), which are `release_gate` dependencies
  (`ci.yml:552-563`) — so skipping them red-gates the release chain.

Interfaces: consumes/produces `update-cli.ts` module constants
`REPO`/`PACKAGE`/`NATIVES_PACKAGE`/`HOMEBREW_FORMULA`/`MISE_TOOL` and
`CURRENT_PACKAGES`; consumed by `getLatestRelease`/`resolveUpdateTarget`;
updates `packages/coding-agent/test/update-cli.test.ts` and
`packages/coding-agent/test/cli/update-cli.test.ts`.
Verify: run the actual bucket, not just static checks —
`bun test packages/coding-agent/test/update-cli.test.ts packages/coding-agent/test/cli/update-cli.test.ts`
must be green. Note `bun run ci:check:full` resolves to `check:ts`
(lint + typecheck only, no test execution), so it would NOT catch any of this.
Plus the T6 assertions that the constants resolve to the `@rigelbuild` scope +
RigelBuild repo and that `buildBunInstallArgs`/`buildNpmInstallArgs` emit the
fork package names.
Depends on: Task 1 (row 1a/1b scope-rename must be present to confirm the
name mapping).

### Task 3: Fork tag-lineage isolation

One commit (overlay row 8, part 2):

- `scripts/release.ts:265`: `--match "v*"` → `--match "v*-rigel.*"`.
- `scripts/fix-changelogs.ts:806` (`latestTag()`): same glob change, so
  `resolveSince` (`:826`) baselines on the fork lineage; the tagless case is
  covered by row 4's diff-floor skip.
- Monotonic guard (`release.ts:275`): NO code change — with the glob isolated,
  `compareVersions` (`packages/utils/src/version.ts:20-28`) orders
  `-rigel.N` correctly within a base and across bases (evidence in Approach
  §2). Add a comment at `:265` stating the invariant: latestTag is always a
  fork tag or empty, never an upstream `vX.Y.Z`.

Interfaces: consumes `git describe` semantics + `compareVersions`; produces
the fork-only `latestTag` resolution in both scripts. Verify: Task 6 tests +
a dry `git describe --tags --abbrev=0 --match "v*-rigel.*"` on the overlay
tip (expect exit 128, exercising the #22 tagless path). Safe by #22's
mechanism (Approach §2): `.nothrow()` describe + `resolveReleaseVersion`'s
`if (latestTag)` guard, load-bearing after every re-sync, not just the first
release.
Depends on: Task 1 (rows 2 and 4 must be present), Task 2.

### Task 4: npm dist-tag + release-notes suffix awareness

One commit (overlay row 8, part 3). Two files:

- `scripts/ci-release-publish.ts` `npmDistTag` (`:139-145`): insert
  `if (/^\d+\.\d+\.\d+-rigel\.\d+$/.test(version)) return "latest";` before the
  unsupported-prerelease throw; update the function doc (`:135-138`). D2 settled
  `latest` (not a dedicated `rigel` tag), consistent with the re-pointed
  `omp update` (D3/Task 2b) reading the fork's `/latest`.
- `scripts/ci-release-notes.ts`: teach both `-rigel.N`-blind regexes the
  optional suffix (rationale + verified failure chain in Approach §2).
  `:66` `enumerateChangelogVersions` (`/^## \[(\d+\.\d+\.\d+)\]/`) is the
  consequential one: without it every fork release publishes EMPTY GitHub
  release notes, because `release.ts:169` writes `## [18.1.10-rigel.1] - <date>`
  which the regex misses, every section renders empty, `main()` takes the
  `sections.length === 0` branch (`:265-269`), and `ci.yml:885` feeds the empty
  file to `softprops/action-gh-release` (`:906-910`) as the release body. Also
  widen `:223`'s release-list filter (`/^v\d+\.\d+\.\d+$/`) so `resolveFloor`
  can floor on a prior rigel release.

Interfaces: consumes/produces `scripts/ci-release-publish.ts` export
`npmDistTag` and `scripts/ci-release-notes.ts` `enumerateChangelogVersions` /
`resolveFloor`; consumed by the publish + release-notes workflow steps.
Verify: Task 6 red-green, including a `## [18.1.10-rigel.1]` heading that
enumerates and renders a non-empty section.
Depends on: D2 (`latest`).

### Task 5: Submit the overlay PR

`jj-vine submit fork/overlay` — ONE PR containing Tasks 1-4/2b's commits,
landed as a MERGE COMMIT (D1) so per-commit identity survives.
Standard loop: review agent, additive fix commits, `gh pr ready`, Matt's gate,
merge. After merge: delete the consumed stale bookmarks
(`upstream-omp/rig-3144-flaky-dispose-test`,
`upstream-omp/rig-2218-t2-f1-authbroker-metrics`,
`upstream-omp/rig-3144-resync-metrics`, `upstream-omp/rig-3227-resync-memtools`,
`upstream-omp/rig-2511-rigelbuild-npm-scope`, old T3 branch heads), keeping
`omp-authbroker-metrics` (upstream PR #10290 head). `main` then equals
`v18.1.10 + complete fork delta`.
Interfaces: consumes the finished bookmark; produces the merged overlay +
bookmark cleanup. Verify: post-merge main-event CI green.
Depends on: Tasks 1-4/2b. Landed via merge commit per D1 (mechanism verified
available: repo allows merge commits, rebase-merge off).

### Task 6: Red-green tests for the release-semantics changes

Written failing-first against Tasks 2-4 (committed with them, listed
separately for the contract): extend `scripts/release.test.ts` (exists on
main, verified `git rev-parse origin/main:scripts/release.test.ts`):

- `validateExplicitVersion`: accepts `18.1.10-rigel.1` / `v18.1.10-rigel.2`;
  rejects `18.1.10`, `18.1.10-rigel.0`, `18.1.10-rc.1`, `18.1.10-rigel.1.2`.
  NOTE: this regex INVERTS existing assertions at
  `scripts/release.test.ts:36-44`: bare `17.2.8`, `0.0.0`, `1.0.0`, and
  `v17.2.8` are currently expected to be ACCEPTED and must be rewritten to
  expect null. The canary-bump cases at `:47-66` survive unchanged
  (`bumpVersion`/`bumpCanaryVersion` stay exported).
- Sentinel round-trip (install-test harness), BOTH directions, exact values:
  `nativeVersionFromExports(["__piNativesV18_1_10_rigel_1"])` must equal
  `"18.1.10-rigel.1"` (not `"18.1.10"` — a truncating implementation satisfies
  a bare "returns the version" assertion vacuously and would ship green), AND
  `nativeVersionFromExports(["__piNativesV18_1_10"])` must equal `"18.1.10"`.
  The plain-sentinel case is the one that defends the PR path: it fails any
  implementation that resolves the version from `packages/natives/package.json`
  instead of from the addon's exports, which would otherwise pass the rigel
  case green while red-gating `ci:test:install-methods` on every
  post-first-release PR (`ci.yml:282-285` fetches the upstream base addon).
- `parseVersion`: `18.1.10-rigel.3` → `[18, 1, 10]`.
- `bumpRigelVersion` (D5): `v18.1.10-rigel.1` → `18.1.10-rigel.2`;
  tagless + pkg `18.1.10` → `18.1.10-rigel.1`.
- `compareVersions` lineage invariants (in the same test file; the comparator
  itself is unchanged): `18.1.10-rigel.2 > 18.1.10-rigel.1`,
  `18.1.10-rigel.10 > 18.1.10-rigel.9` (numeric identifier order),
  `18.1.12-rigel.1 > 18.1.10-rigel.5`, and the guard hazard
  `18.1.10-rigel.1 < 18.1.10` documented as the reason for Task 3's glob.
- `npmDistTag`: `18.1.10-rigel.1` → `latest` (D2);
  `18.1.10-rc.1` still throws; `18.1.11-canary.1` → `canary`.
- Release notes (Task 4): a changelog containing `## [18.1.10-rigel.1] - <date>`
  is enumerated by `enumerateChangelogVersions` and its section renders
  non-empty (red before the `:66` regex widening, green after).
- `omp update` constants (Task 2b): `PACKAGE`/`NATIVES_PACKAGE` resolve to the
  `@rigelbuild` scope and `REPO` to `RigelBuild/oh-my-pi`;
  `buildBunInstallArgs`/`buildNpmInstallArgs` emit the fork package names; and
  `renamePackageName(PACKAGE)` equals the new `PACKAGE` constant (pins the
  source constants to `rigel-scope-rename.ts`'s rule so they cannot drift).
  Plus the ~41 EXISTING assertions in
  `packages/coding-agent/test/update-cli.test.ts` and
  `packages/coding-agent/test/cli/update-cli.test.ts` updated to the fork
  literals (enumerated in Task 2b).

Interfaces: consumes the Task 2-4/2b exports; produces coverage in
`scripts/release.test.ts`, the install-test harness, and the two update-cli
test files. Verify: `bun test scripts/release.test.ts` plus
`bun test packages/coding-agent/test/update-cli.test.ts packages/coding-agent/test/cli/update-cli.test.ts`
red before each change, green after. Do NOT rely on `ci:check:full` (no tests).

### Task 7: Release + runbook handoff

File one `human-action` Linear issue (team Rigel, assigned Matt, per
`skill://human-action-handoff` + `rule://linear-project-taxonomy`) containing:
(a) the first fork release command `bun scripts/release.ts 18.1.10-rigel.1`
(the first version, per D6) run from a clean `main` checkout;
(b) the recurring re-sync runbook from Approach §1 verbatim, including the
admin-API main reset that only Matt executes. Preconditions surfaced in the
issue: publishing under `@rigelbuild` from RigelBuild CI needs its own
npm-org trusted-publishing (or token) setup (`ci.yml:967-1005` configures
trust for `@oh-my-pi` only, via `scripts/setup-npm-trust.ts`), and
`release_brew` is a no-op without `HOMEBREW_TAP_DEPLOY_KEY` on the fork
(`ci.yml:1010-1016`). After the first native release
publishes `@rigelbuild/omp-natives-linux-x64@18.1.10-rigel.1`, flip the CI
natives fetch (`.github/workflows/ci.yml:281-290`) from the upstream scope to
`@rigelbuild` per fork-resync reconciliation note 2 — that flip is a small
follow-up PR, gated on the publish existing.
Interfaces: consumes the merged overlay + this record; produces the Linear
runbook issue and (post-release) the natives-fetch flip PR. Verify: Matt's
release run completes `=== Released v18.1.10-rigel.1 ===` and
`npm view @rigelbuild/omp-coding-agent@18.1.10-rigel.1 dist-tags` shows
`latest` (the authoritative package literal per Task 2b's rename mapping).
Depends on: Task 5 merged.

## Tasks

- [ ] T1: Construct `fork/overlay` from the 11 reconciled source commits (rows 1a-7 plus row 10's three RIG-3339 commits; 2 reworks). Rows 8-9 land in T2/T2b/T3/T4
- [ ] T2: `-rigel.N` acceptance in `release.ts` + install-test sentinel ROUND-TRIP fix + `rigel` bump keyword (D5)
- [ ] T2b: Re-point `omp update` constants to the `@rigelbuild` fork scope + RigelBuild repo, incl. the ~41 existing test assertions (D3)
- [ ] T3: Tag-lineage isolation: `--match "v*-rigel.*"` in `release.ts:265` + `fix-changelogs.ts:806`
- [ ] T4: `npmDistTag` maps `-rigel.N` → `latest` (D2) + `ci-release-notes.ts` `:66`/`:223` suffix awareness (else empty release notes)
- [ ] T5: Submit the single overlay PR as a merge commit (D1); post-merge bookmark cleanup
- [ ] T6: Red-green tests in `scripts/release.test.ts` + sentinel matcher (lands with T2-T4)
- [ ] T7: Human-action handoff: first `18.1.10-rigel.1` release (D6) + recurring re-sync runbook; then the natives-fetch scope flip

## Resolved decisions

All questions below were put to Matt in one batched `ask` (2026-09-06) and
ruled; the record freezes with zero open load-bearing questions.

- **D1 (was OQ1, gates T5): the overlay PR lands as a MERGE COMMIT with commits
  preserved.** Squash would collapse the delta into one main commit, destroying
  the per-commit shrinkage protocol (dropping an upstreamed commit needs
  per-commit identity) and the `git log <base>..main` = upstream-work-queue
  property. Mechanism verified:
  `gh api repos/RigelBuild/oh-my-pi --jq '.allow_merge_commit,.allow_squash_merge,.allow_rebase_merge'`
  returns merge:true, squash:true, rebase:false. Matt ruled: merge commit for
  the overlay PR only; ordinary feature PRs keep the squash convention.
- **D2 (was OQ3, gates T4): `-rigel.N` publishes to the npm dist-tag
  `latest`.** The `@rigelbuild` scope is fork-only, so there is no upstream
  `latest` to protect, and re-pointed `omp update` (D3) reads the fork's
  `/latest`. `npmDistTag` maps `-rigel.N` to `latest`.
- **D3 (was OQ6, gates T7 + self-update): the overlay RE-POINTS `omp update`'s
  hard-pinned upstream constants to the fork.**
  `packages/coding-agent/src/cli/update-cli.ts` pins
  `REPO = "can1357/oh-my-pi"` (`:26`), `PACKAGE = "@oh-my-pi/pi-coding-agent"`
  (`:27`), `NATIVES_PACKAGE = "@oh-my-pi/pi-natives"` (`:53`), and
  `HOMEBREW_FORMULA`/`MISE_TOOL` (`:28-29`). #20's `rigel-scope-rename.ts`
  rewrites published tarballs at publish time only, not these source constants
  (verified: #20 touches only `ci-release-publish.ts`,
  `rigel-scope-rename.{ts,test.ts}`, `setup-npm-trust.ts`), so a fork-installed
  `omp update` would resolve UPSTREAM's `@oh-my-pi` latest
  (`18.1.11 > 18.1.10-rigel.1`) and silently shed the fork delta. Matt ruled:
  re-point the constants to the `@rigelbuild` scope + the RigelBuild repo in the
  overlay so fork self-update stays on the fork. This is overlay row 9 / Task 2b
  (below).
- **D4 (was OQ2): overlay bookmark name `fork/overlay`** — grep-distinct from
  the `upstream-omp/*` task namespace and self-describing.
- **D5 (was OQ4): add a `rigel` bump keyword.** `bun scripts/release.ts rigel`
  increments N; cheap once the lineage glob exists, removes version arithmetic
  from Matt's manual step, and the explicit `18.1.10-rigel.N` form stays
  accepted.
- **D6 (was OQ5): the first fork release is `18.1.10-rigel.1`.** `<base>` names
  the upstream base the fork sits on, not tree equality; the `@rigelbuild` npm
  line (last published 18.0.3) stays monotonic since
  `18.1.10-rigel.1 > 18.0.3`.
