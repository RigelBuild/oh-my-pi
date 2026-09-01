# CI-triggered release

Design record for moving the release bump/commit/tag half from a maintainer
machine into CI. Written before implementation; frozen on merge. Executing
agents build against this record.

## Problem / Intent

A release is currently cut by running `bun scripts/release.ts <version>` on a
maintainer machine. Step 6 of `cmdRelease` runs the full local check suite
(`scripts/release.ts:475-478`):

```ts
// 6. Run checks
console.log("Running checks...");
await $`bun run check`;
```

where `check` fans out to the Rust side too (`package.json:100`):

```json
"check": "bun run --parallel check:ts check:rs",
```

That makes a release depend on the maintainer's local toolchain. The last
attempt died because the machine lacked `cmake`, needed by the `audiopus_sys`
crate in the Rust check. The check is also redundant: the push at the end of
the script triggers a CI run that executes the same suite on `omp-kata`
runners with a warm toolchain, and the script then just watches that run
(`scripts/release.ts:513-515`):

```ts
// 9. Watch CI
console.log("Watching CI...");
const success = await watchCI();
```

Intent: a maintainer triggers a workflow (`gh workflow run` or the Actions UI)
and the server performs bump, changelog, commit, and tag where the toolchain
already exists. No local toolchain is needed for a release.

## Approach

Reuse `scripts/release.ts` rather than reimplementing its steps in YAML. The
script already does everything a release needs; only two steps are wrong for a
CI host as written: the local `bun run check` and `watchCI` (CI is the watcher
now, and its retry instructions at `scripts/release.ts:524-530` are addressed to
a human at a terminal).

The `bun run check` omission is the subtle one, and it is a timing change, not a
pure redundancy. `check` fans out to `check:ts` + `check:rs`
(`package.json:100`); the CI run the push triggers runs only `check:ts` in its
lint/type job (`ci:check:full = bun run check:ts`, `package.json:120`), with the
Rust half covered separately by the bazel `rust_validate` job. So coverage is
approximately equivalent but not the literally-same suite. The real difference is
*when*: locally, `check` ran AFTER the lockfile regeneration
(`rm -f bun.lock; bun install; cargo generate-lockfile`,
`scripts/release.ts:445-449`) and BEFORE the push, so it was the sole gate over a
freshly regenerated lockfile that may resolve dependency versions no prior CI run
tested. Omitting the check entirely converts that pre-push gate into post-push
detection: a failure now lands a tagged bump on `main` and the publish fails
with the version number already consumed. The native-toolchain failure that
motivates this design (missing `cmake` for `audiopus_sys`) implicates only
`check:rs`; `check:ts` (biome + workspace `tsc`, `package.json:101`) needs no
native toolchain. Whether `prepare` keeps `check:ts` as a pre-push gate (dropping
only `check:rs`) or omits the check entirely and accepts fix-forward on failure
is Open Question (f).

Split `cmdRelease` into a `prepare` path invoked as
`bun scripts/release.ts prepare <version|bump>` that performs, unchanged:

1. Version validation and resolution: `validateExplicitVersion` normalization
   (`scripts/release.ts:298-312`) and `resolveReleaseVersion` against the
   latest `v*` tag (`scripts/release.ts:230-257`).
2. Pre-flight: on `main` (`scripts/release.ts:317-321`), clean working
   directory (`scripts/release.ts:324-330`).
3. Version bumps: public `packages/*/package.json`
   (`scripts/release.ts:352-370`), root catalog `@oh-my-pi/*` entries
   (`scripts/release.ts:380-385`), Cargo workspace version
   (`scripts/release.ts:387-392`), pi-natives sentinel across
   `crates/pi-natives/src/lib.rs` and `packages/natives/native/{index.d.ts,index.js}`
   (`scripts/release.ts:421-441`).
4. Lockfile and generated-config regeneration: `bun install`,
   `cargo generate-lockfile`, `generateNixBunDeps`,
   `bun scripts/gen-clippy-bazelrc.ts` (`scripts/release.ts:443-453`).
5. Changelogs: `runChangelogFixer` plus `updateChangelogsForRelease`, skipped
   for canary (`scripts/release.ts:455-473`).
6. Commit `chore: bump version to ${version}` (`scripts/release.ts:480-484`)
   and the atomic branch-plus-tag push (`scripts/release.ts:506-511`):

   ```ts
   await git(["tag", "-f", tagRef]);
   await git(["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `${sha}:refs/tags/${tagRef}`]);
   ```

   The atomic push by object id sidesteps the `git maintenance` tag-prune race
   documented at `scripts/release.ts:486-505` and must be kept verbatim.

`prepare` omits step 6 (`bun run check`) and step 9 (`watchCI`). Whether the
existing full local `cmdRelease` survives as a command, and whether the omission
is a subcommand or a flag, is Open Question (c).

A new workflow `.github/workflows/release.yml` exposes `workflow_dispatch`
with a version input, runs on `omp-kata` (warm bun/cargo/bazel caches; the
hosted-runner cargo cache is cold, see the comment at
`.github/workflows/ci.yml:155-160`), configures a git identity, and invokes
the `prepare` path. The resulting push lands on `main` with the tag, and the
existing release machinery reacts with no changes:

- The `ci.yml` concurrency group already recognizes a release run by commit
  subject or tag ref and gives it a per-sha never-cancel group
  (`.github/workflows/ci.yml:74-76`):

  ```yaml
  group: "${{ (startsWith(github.event.head_commit.message,
    'chore: bump version to ') || startsWith(github.ref, 'refs/tags/v') ||
    github.event_name == 'workflow_dispatch') &&
    format('release-{0}', github.sha) || github.ref }}"
  ```

  (wrapped for width and the `${{ github.workflow }}-` prefix elided; the
  source is one line.)

- `release_metadata` detects the tag at HEAD post-hoc
  (`.github/workflows/ci.yml:95-144`), probing with
  `git tag --points-at HEAD | grep -E '^v[0-9]' | head -n1`
  (`.github/workflows/ci.yml:129`), and downstream publish jobs gate on its
  `is-release` output. All publish jobs stay as they are.

One auth caveat shapes the whole design: `ci.yml` runs with
`permissions: contents: read` (`.github/workflows/ci.yml:81-82`), and a push
made with the default `GITHUB_TOKEN` does not start `on: push` workflow runs.
A `workflow_dispatch` triggered with `GITHUB_TOKEN` does start a run, and
`ci.yml` is already wired to treat a dispatch as a candidate release
(`.github/workflows/ci.yml:59-64`, `:74-76`), so the run can be started either
by a stored push credential or by the workflow dispatching `ci.yml` itself.
See Open Questions (a) and (d).

Failure containment: every mutation before the push lives only in the
ephemeral runner checkout, and the atomic push (`scripts/release.ts:506-511`)
is the sole externally visible change, so any *pre-push* failure (a sentinel
verify fail, a changelog error, a non-fast-forward race with a human push)
leaves origin untouched and the version number unconsumed. For pre-push
failures this is strictly safer than the local flow, where a failed run leaves a
dirty tree on the maintainer's machine. The only non-atomic residue is the local
`git tag -f` before the push, which is disposable
(`scripts/release.ts:486-505`). A *post-push* failure is different: once the
atomic branch-plus-tag push lands, a later publish-side failure leaves a tagged
bump on `main` with the version consumed. `resolveReleaseVersion` refuses to
re-cut the same version (`scripts/release.ts:250-252`) and the prepare push
refspec is unforced, so there is no CI-side equivalent of the local retry
recipe's force-retag (`scripts/release.ts:520-530`). The recovery story is
therefore fix-forward to the next patch version, documented in Task 4; Open
Question (f) (keeping `check:ts` pre-push) directly narrows how often a
post-push failure can happen.

## Alternatives considered

- **Reimplement the release steps in workflow YAML.** Rejected. The script
  encodes non-obvious invariants (the sentinel rename verification at
  `scripts/release.ts:433-441`, the atomic-push race workaround at
  `scripts/release.ts:486-505`, first-release and canary handling in
  `resolveReleaseVersion`) that would be duplicated and would drift. The repo
  also enforces TypeScript over bash for real logic via the `no-bash-gate` CI
  task, and a YAML reimplementation is exactly that kind of logic.

- **Keep the local flow and just fix the toolchain (install cmake).** Rejected
  by the maintainer's ruling. It patches one machine; the next maintainer or
  the next native dependency reintroduces the problem, and the local check
  remains a redundant copy of what CI runs anyway.

- **Release PR instead of direct push.** Live fork, not rejected; see Open
  Question (a). The workflow would put the bump commit on a branch and open a
  PR the maintainer merges, preserving the merge gate. It costs an extra human
  step and a second CI cycle, and needs care with the tag: release detection
  keys on the `chore: bump version to` subject prefix or a tag at HEAD, and
  a squash merge rewrites the commit, so the tag would have to be laid on
  the merged commit by a post-merge step.

## Global Constraints

- Scripts with real logic are TypeScript run via `bun`; the `no-bash-gate` CI
  task enforces this. Workflow steps stay thin wrappers around
  `scripts/release.ts`.
- The release-prepare job compiles nothing (`cargo generate-lockfile` is a
  registry-index fetch, `gen-clippy-bazelrc` is pure Bun TOML parsing, the
  nix-bun generator falls back to `bunx bun2nix` when nix is absent), so it is
  a light job, not a heavy one. The runner (`omp-kata` vs hosted
  `ubuntu-22.04`, which ships `cargo` and avoids queueing behind the 4-runner
  kata pool that `.github/workflows/ci.yml:97-99` warns about) is a settle-at-
  review choice, not the reflexive heavy-job-on-kata rule; see the runner Open
  Question.
- The publish half of the release (`release_gate`, `release_binary*`,
  `release_npm`, `release_github`, brew) already lives in `ci.yml` and is out
  of scope. This design only moves the bump/changelog/commit/tag half.
- Canary releases flow through the same path with their existing semantics
  (changelog skip at `scripts/release.ts:456-457`, channel detection at
  `.github/workflows/ci.yml:137-139`); no canary logic changes.
- Docs are flat `docs/*.md`; this record lives at `docs/release-ci.md`.
- The atomic push refspec form (`<sha>:refs/tags/<tag>`) is preserved verbatim
  wherever the push happens.

## Plan

### Task 1: `prepare` path in scripts/release.ts

Extract the bump/changelog/commit/tag portion of `cmdRelease`
(`scripts/release.ts:291-533`) into a path reachable as
`bun scripts/release.ts prepare <version|bump>`, per the mechanism chosen in
Open Question (c). Wire it into the CLI dispatch at
`scripts/release.ts:539-566` next to the existing `watch` subcommand.

Interfaces:

- Consumes: `versionOrBump` (explicit semver or `major|minor|patch|canary`),
  same validation as today (`validateExplicitVersion`,
  `resolveReleaseVersion`).
- Produces: the `chore: bump version to ${version}` commit and `v${version}`
  tag, pushed atomically to origin (or to a release branch, per Open
  Question (a)).
- Omits: step 9 `watchCI` (`scripts/release.ts:513-532`), replaced by the
  run-started check in Task 2. Step 6 `bun run check`
  (`scripts/release.ts:475-478`) is narrowed rather than dropped whole per Open
  Question (f): the recommendation keeps `check:ts` as a pre-push gate over the
  regenerated lockfile and omits only the toolchain-heavy `check:rs`.
- Guards: hard-fail when the resolved `latestTag` is empty. `git describe`
  returns nothing on a shallow or tagless checkout (`scripts/release.ts:335-341`,
  `.nothrow()` leaves `latestTag=""`), and an explicit version then takes the
  "first release" branch that skips the greater-than-latest comparison
  (`scripts/release.ts:253-257`). This fork already has `v*` tags, so an empty
  `latestTag` in CI means a mis-configured checkout, not a real first release;
  fail loudly instead of cutting a mistagged one.
- Unchanged: `cmdWatch` / `watchCI` remain for local use.

### Task 2: `.github/workflows/release.yml`

New workflow, dispatch-only.

Interfaces:

- Consumes: `workflow_dispatch` input(s) per Open Question (b); a push-capable
  token per Open Question (d).
- Produces: a job that checks out `main` with full history and tags
  (`fetch-depth: 0`, `fetch-tags: true`, so `git describe --tags` at
  `scripts/release.ts:340` resolves and the empty-`latestTag` guard in Task 1
  cannot trip on a shallow checkout), sets the git author/committer identity,
  runs `bun scripts/release.ts prepare "$VERSION"`.
- Runner: see the runner Open Question below. `prepare` compiles nothing (it
  runs `bun install`, `cargo generate-lockfile` which is a registry-index
  fetch, `generateNixBunDeps`, and `gen-clippy-bazelrc` which is pure Bun TOML
  parsing), so a hosted `ubuntu-22.04` with `cargo` preinstalled is a candidate
  alongside `omp-kata`.
- Dispatch-ref guard: `if: github.ref == 'refs/heads/main'` at the job level.
  `workflow_dispatch` runs the workflow definition as it exists on the
  dispatched ref, so without this a modified copy on a branch could run with the
  release credentials. Pinning the checkout to `main` alone does not close this.
- Permissions: `contents: write` at the job level for the push; and, when Open
  Question (d) resolves to the chained-dispatch trigger, `actions: write` for the
  `gh workflow run ci.yml` step. Everything else stays `read`. The chained
  dispatch is a `POST .../actions/workflows/ci.yml/dispatches` call, which
  `GITHUB_TOKEN` can make only with `actions: write`, so a `contents: write`-only
  job would push the tagged bump and then fail at the dispatch step with a 403,
  manufacturing the exact tagged-bump-with-no-publish state the run-started check
  below exists to catch. `actions/checkout` must keep its default
  `persist-credentials: true` so the in-job `GITHUB_TOKEN` can push.
- Concurrency: a `release-prepare` group with `cancel-in-progress: false` so two
  dispatches serialize rather than race a push to `main`. This serializes but does
  not deduplicate: a queued second dispatch with a bump keyword re-resolves against
  the just-pushed tag (`scripts/release.ts:230-244`) and would cut an unintended
  second release; an explicit duplicate version fails loudly at the
  greater-than-latest guard (`scripts/release.ts:250-252`). Mitigate the
  double-dispatch foot-gun by refusing at the top of the job when another
  `release.yml` run is already `in_progress`/`queued`
  (`gh run list --workflow release.yml --status in_progress,queued`), so a
  Actions-UI double-click fails fast instead of cutting a second release
  unattended.
- Run-started check: after the push, poll for the triggered `ci.yml` run at the
  pushed sha (`gh run list --commit <sha>`), then wait for its `release_metadata`
  job to complete and assert `is-release=true`, not merely that a run exists. A
  run at the correct sha whose tag probe returns empty (`git tag --points-at HEAD`
  at `.github/workflows/ci.yml:129`, on any fetch-tags anomaly) yields
  `is-release=false` and the same silent non-publish, so run-existence alone is too
  weak a proxy; assert the release condition to match Task 3's verification
  criterion. Fail the job loudly on either miss. This is the one non-redundant duty
  of the deleted `watchCI`: a push can succeed while the release run never starts
  or never recognizes itself as a release (a token whose semantics suppress the
  trigger, a future `on.push` path-filter gap of the kind
  `.github/workflows/ci.yml:25-27` records, or the ref-vs-sha race in Open
  Question (d)), which otherwise leaves a tagged bump on `main` with no publish and
  no error anywhere. `gh run list --commit` requires gh >= 2.40 (present on hosted
  `ubuntu-22.04`; verify on `omp-kata` if the runner question resolves that way),
  and `GH_TOKEN` must be exported for the `gh` calls.
- LFS: bump commits carry no Git LFS content, so the LFS pre-push hook the
  atomic-push comment describes (`scripts/release.ts:503-505`) is not needed on
  the runner (`actions/checkout` defaults `lfs: false`); note this rather than
  leave the ported comment implying machinery that is absent.

### Task 3: main-branch trigger path

Make the pushed release commit actually start a `ci.yml` release run, per the
trigger mechanism chosen in Open Question (d).

Interfaces:

- Consumes: the resolution of Open Questions (a) and (d). Main's branch
  protection is now a recorded fact, not an unresolved input: an active ruleset
  with zero bypass actors (see the load-bearing fact under Open Questions), so
  any direct-push (a) needs a bypass actor *added*, and a Release-PR (a) needs
  none.
- Produces: a working path where the release run starts for the pushed sha,
  verified by the Task 2 run-started check observing a `release_metadata` run
  with `is-release=true`. The concrete work depends on (a)/(d): the recommended
  `GITHUB_TOKEN` + tag-ref chained-dispatch needs no stored secret (the workflow
  pushes, then dispatches `ci.yml --ref "v${VERSION}"` itself) but does need the
  workflow identity as a branch-protection bypass actor for the push, gated
  behind a GitHub Environment approval if (a) resolves that way; a PAT / deploy
  key / GitHub App option additionally needs the secret created, stored, and its
  expiry/rotation documented here; a Release-PR (a) replaces the push+dispatch
  with a branch push + `gh pr create` + the tag-choreography step. Record the
  exact mechanism in this file when implemented.

### Task 4: docs and command update

Interfaces:

- Consumes: the final trigger invocation from Task 2.
- Produces: `.omp/commands/release.md` rewritten from the local-run
  instructions (currently `bun scripts/release.ts $ARGUMENTS` at
  `.omp/commands/release.md:17-19` plus a local retry recipe) to the dispatch
  invocation (`gh workflow run release.yml -f version=...`) and the CI-failure
  retry story. That story must state the post-push protocol explicitly: a failed
  release run cannot be retried at the same version (`resolveReleaseVersion`
  rejects it, `scripts/release.ts:250-252`; the prepare push is unforced, so the
  local force-retag recipe at `scripts/release.ts:520-530` has no CI equivalent),
  so recovery is fix-forward to the next patch version. The one exception is a
  ref-vs-sha miss under a `--ref main` dispatch (Open Question (d)), whose
  recovery is a tag-ref re-dispatch `gh workflow run ci.yml --ref "v${VERSION}"`.
  Append a short "how a
  release works now" section to this record.

### Task 5: end-to-end verification

Interfaces:

- Consumes: Tasks 1-4 merged.
- Produces: one canary release cut entirely through the new workflow
  (canary avoids consuming a stable version number), with the full chain
  observed: dispatch, `prepare` push, `ci.yml` release run,
  `release_metadata` reporting `channel=canary`, publish jobs green.

## Tasks

- [ ] Task 1: `prepare` path in `scripts/release.ts`, CLI wiring, `check:rs`/
  `watchCI` omitted with `check:ts` kept pre-push per Open Question (f),
  empty-`latestTag` guard
- [ ] Task 2: `.github/workflows/release.yml` dispatch workflow with the
  dispatch-ref guard, `contents:write`+`actions:write` permissions, serialized
  concurrency with the in-flight-run refusal, and the run-started +
  `is-release=true` check
- [ ] Task 3: main-branch trigger path per Open Questions (a)/(d)
  (tag-ref chained dispatch plus the branch-protection bypass actor, gated by an
  Environment approval, or a Release-PR that needs no bypass)
- [ ] Task 4: `.omp/commands/release.md` and record update, including the
  fix-forward post-push failure protocol
- [ ] Task 5: canary release through the new path

## Open Questions

Maintainer decisions. (a), (d), and (f) are load-bearing: the workflow's shape,
permissions, secrets, and the post-push failure surface all depend on them.
(b), (c), and (e) are surfaced for completeness and can be settled at review.

Load-bearing fact both (a) and (d) turn on: `main` is protected by an active
repository ruleset (`pull_request`, `non_fast_forward`, `required_status_checks`,
`deletion`) with **zero bypass actors**. Today nobody, maintainer included, can
push directly to `main`; every change lands through a reviewed PR. This changes
the framing of (a) below: "direct push by the workflow" is not a faithful port of
the current mechanics, because the current mechanics do not permit a direct push
at all.

### (a) Where the bump commit lands (load-bearing)

- **Direct push to `main` by the workflow.** One CI cycle, no extra human step,
  the same atomic branch-plus-tag push. But given the ruleset above it requires
  *adding* a standing bypass actor for the release workflow's identity: a new,
  permanent, always-on push-to-`main` capability that does not exist today, whose
  blast radius is any future compromise of the workflow file. It also widens the
  release-capable set: `workflow_dispatch` is open to every write-access user
  (see (d)), so a bypass exercised on their behalf lets anyone with write access
  cut a release and land a bump on `main`, which no write user can do today.
- **Direct push plus a GitHub Environment with required reviewers on the
  release job.** Same single CI cycle and no tag choreography, but the job
  pauses for one approval click in the Actions UI before it pushes. Restores an
  explicit human gate at the push and, against the ruleset above, closes both new
  exposures the bare direct push opens (the standing bypass actor and the widened
  dispatcher set) for the cost of one click on an infrequent, dispatch-initiated
  action. Still needs the bypass actor to exist, but gates its use behind an
  approval.
- **Release PR the maintainer merges.** The workflow puts the bump commit on
  a branch and opens a PR; the merge to `main` is the human gate, and no bypass
  actor is ever added. This is the only option that keeps the current
  zero-bypass ruleset intact. Costs an extra human step and a second CI cycle,
  and the tag needs care: release detection keys on the commit subject or a tag
  at HEAD (`.github/workflows/ci.yml:74-76`, `:129`), and a squash merge
  rewrites the commit, so this path needs either a merge commit or a
  post-merge step that lays `v${version}` on the merged sha.
- **Recommendation:** the Environments option. The honest argument for a direct
  push is that the bump content was never reviewed (the local script bumps,
  commits, and pushes with nobody reviewing the mechanical version bumps or the
  changelog rewrite), so server-side pushing removes no review gate that existed.
  But that argument covers *content* review, not *push capability*: the local
  push ran under a specific maintainer's credential, whereas a bare workflow
  direct push adds a standing bypass actor and hands push-to-`main`-via-release to
  every write user. The Environments option keeps the no-second-cycle, no-tag-
  choreography benefits of a direct push while gating that new capability behind
  one approval click. The Release-PR option is the most conservative (no bypass
  actor at all) if the maintainer prefers to preserve the zero-bypass ruleset
  outright, at the cost of the extra cycle and the tag choreography.

### (b) Version input shape

- Explicit semver only, bump keyword only, or both. The script already
  accepts both (`scripts/release.ts:298-312` normalizes explicit versions;
  `resolveReleaseVersion` handles `major|minor|patch|canary`).
- **Recommendation:** both, as a single required string input validated by
  the script's existing logic. No new validation code.

### (c) Reuse mechanism in scripts/release.ts

- A `--skip-check` / `--ci` flag on `cmdRelease` that omits the check and
  watch steps: smallest diff, but grows a mode switch inside one long
  function.
- A `prepare` subcommand alongside `watch`: two clearly named entry points,
  and the local full-release command keeps working for anyone with a
  complete toolchain.
- **Recommendation:** the `prepare` subcommand. The Plan above is written
  against it; a flag would only relabel Task 1.

### (d) How the release run gets triggered (load-bearing)

Who may dispatch is not the hard part: `workflow_dispatch` is limited to users
with write access by GitHub default, matching the current set who can run the
local script. The hard part is making the pushed commit actually start a
`ci.yml` release run. A push made with the default `GITHUB_TOKEN` does not
start `on: push` workflow runs, but GitHub documents an exception:
`workflow_dispatch` and `repository_dispatch` events always create a run even
when triggered with `GITHUB_TOKEN`
(<https://docs.github.com/actions/using-workflows/triggering-a-workflow>). Three
options:

- **`GITHUB_TOKEN` push, then chained `workflow_dispatch` of `ci.yml`.** The
  release job pushes with the built-in `GITHUB_TOKEN`, then runs
  `gh workflow run ci.yml` from the same job (needs `contents: write` for the
  push AND `actions: write` for the dispatch, see Task 2). No stored secret, no
  rotation, no expiry cliff. `ci.yml` already accepts `workflow_dispatch`
  (`.github/workflows/ci.yml:59-64`) and schedules any dispatch into the
  never-cancel release group (`.github/workflows/ci.yml:74-76`, third disjunct).
  Two sub-choices for the dispatch ref:
  - **`--ref "v${VERSION}"` (the tag just pushed).** `release_metadata` reads the
    tag straight from `github.ref_name` on a tag-ref run
    (`.github/workflows/ci.yml:123-126`), and `fetch-tags` is correctly scoped
    away from tag refs (`.github/workflows/ci.yml:109-115`). Because the tag was
    laid on its sha by the atomic push one step earlier, the dispatched run
    executes at exactly the pushed sha, so there is no ref-vs-sha race at all.
  - **`--ref main`.** `release_metadata` detects the tag at HEAD via
    `git tag --points-at HEAD` (`.github/workflows/ci.yml:127-130`), but
    `workflow_dispatch` resolves a ref at run-creation time, so a human push
    landing on `main` in the push-to-dispatch window (seconds) makes the run
    execute at the newer untagged tip, `release_metadata` reports
    `is-release=false`, and the release silently does not publish. This is *not*
    self-healing by re-dispatching `main` (a re-dispatch resolves `main` again,
    to whatever tip it now has); the only recovery that targets the raced sha is
    dispatching the tag ref, i.e. falling back to the first sub-choice. The Task 2
    run-started check detects the miss.
- **Fine-grained PAT (or deploy key) push.** A stored `contents: write`
  credential whose push triggers `ci.yml` via the ordinary `on: push` path.
  No ref-vs-sha race. Cost: a long-lived repo-write secret living on the runner,
  a human rotation loop (in tension with the no-manual-steps principle this
  design otherwise honors), and an expiry cliff.
- **GitHub App installation token.** Best security posture (short-lived
  installation tokens, no expiry cliff), highest setup cost.
- Bypass-actor note: the branch-protection bypass that a push to `main` requires
  (see the load-bearing fact above (a)) is a property of the *push target*, not
  the *credential*: every direct-push option here, `GITHUB_TOKEN` included,
  needs the workflow identity added as a bypass actor. The bypass cost belongs to
  option (a)'s direct-push choice, not to any one credential in (d). A
  Release-PR (a) removes the bypass requirement for all of these.
- **Recommendation:** the `GITHUB_TOKEN` + chained-dispatch option, dispatching
  the **tag ref** (`--ref "v${VERSION}"`). It removes the standing secret, the
  rotation loop, and Task 3's PAT plumbing entirely, and the tag-ref dispatch
  eliminates the ref-vs-sha race rather than merely detecting it. If (a) resolves
  to Release-PR, this sub-question narrows to how the merged commit gets its tag
  and CI run, folded into (a)'s tag-choreography step.

### (e) Runner for the release-prepare job

- `omp-kata` (self-hosted, warm caches) versus hosted `ubuntu-22.04`. `prepare`
  compiles nothing, so either works; the security angle mildly favors hosted if a
  stored push credential is chosen in (d), since it keeps a repo-write secret off
  self-hosted infrastructure. The `GITHUB_TOKEN` + chained-dispatch option in (d)
  removes that concern. Note the "ships `cargo`" framing is approximate:
  `rust-toolchain.toml` pins a toolchain rustup downloads on first `cargo`
  invocation (a ~1 min network fetch, not a correctness issue), and if Open
  Question (f) keeps `check:ts` pre-push that step still needs no Rust toolchain.
- **Recommendation:** hosted `ubuntu-22.04`. `prepare` is a light job and this
  avoids both the kata-pool queue and a secret-on-self-hosted question; revisit
  only if a `prepare` step turns out to need a warm native cache.

### (f) Keep `check:ts` as a pre-push gate (load-bearing)

`prepare` regenerates the lockfile from scratch (`rm -f bun.lock; bun install`,
`scripts/release.ts:445-449`) immediately before the push. The local flow gated
that regenerated lockfile behind `bun run check` before pushing; a pure CI-side
omission moves all validation after the push, where a failure lands a tagged bump
on `main` with the version consumed (see Failure containment).

- **Keep `check:ts` in `prepare`, drop only `check:rs`.** `check:ts` (biome +
  workspace `tsc`, `package.json:101`) needs no native toolchain, so it never hits
  the `cmake`/`audiopus_sys` failure that motivates this design; `check:rs`
  (`package.json:103`) is the toolchain-heavy half and is covered post-push by the
  bazel `rust_validate` job. This restores the pre-push gate over the regenerated
  lockfile at a few minutes' cost and zero toolchain burden.
- **Omit the check entirely; accept fix-forward.** Smallest `prepare`, but a
  post-push `check:ts`-class failure (a lockfile resolution no prior CI exercised)
  is only caught after the tag lands, and recovery is fix-forward to the next
  patch version (Task 4), never a re-cut of the same version
  (`scripts/release.ts:250-252`).
- **Recommendation:** keep `check:ts` pre-push. It is the cheap half, needs no
  native toolchain, and is the only validation of the freshly regenerated
  lockfile before the irreversible push; dropping it trades a few CI minutes for a
  tagged-broken-`main` + burned-version risk on exactly the input `prepare`
  itself just changed.
