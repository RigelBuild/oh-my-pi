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
CI host: the local `bun run check` (redundant with the CI run the push
triggers) and `watchCI` (CI is the watcher now, and its retry instructions at
`scripts/release.ts:524-530` are addressed to a human at a terminal).

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
is the sole externally visible change, so any pre-push failure (a sentinel
verify fail, a changelog error, a non-fast-forward race with a human push)
leaves origin untouched and the version number unconsumed. This is strictly
safer than the local flow, where a failed run leaves a dirty tree on the
maintainer's machine. The only non-atomic residue is the local `git tag -f`
before the push, which is disposable (`scripts/release.ts:486-505`).

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
- Omits: step 6 `bun run check` (`scripts/release.ts:475-478`) and step 9
  `watchCI` (`scripts/release.ts:513-532`), the latter replaced by the
  run-started check in Task 2.
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
- Permissions: `contents: write` at the job level; everything else stays
  `read`.
- Concurrency: a `release-prepare` group with `cancel-in-progress: false` so two
  dispatches serialize rather than race a push to `main`. Note this serializes,
  it does not deduplicate: a queued second dispatch with a bump keyword
  re-resolves against the just-pushed tag (`scripts/release.ts:230-244`) and
  would cut an unintended second release; an explicit duplicate version fails
  loudly at the greater-than-latest guard (`scripts/release.ts:250-252`).
- Run-started check: after the push, poll for a `ci.yml` run matching the pushed
  sha (`gh run list --commit <sha>`) and fail the job loudly if none appears
  within a bounded wait. This is the one non-redundant duty of the deleted
  `watchCI`: a push can succeed while the release run never starts (a token
  whose semantics suppress the trigger, or a future `on.push` path-filter gap of
  the kind `.github/workflows/ci.yml:25-27` already records), which otherwise
  leaves a tagged bump on `main` with no publish and no error anywhere.
- LFS: bump commits carry no Git LFS content, so the LFS pre-push hook the
  atomic-push comment describes (`scripts/release.ts:503-505`) is not needed on
  the runner (`actions/checkout` defaults `lfs: false`); note this rather than
  leave the ported comment implying machinery that is absent.

### Task 3: main-branch trigger path

Make the pushed release commit actually start a `ci.yml` release run, per the
trigger mechanism chosen in Open Question (d).

Interfaces:

- Consumes: the resolution of Open Questions (a) and (d); repo branch
  protection settings for `main`.
- Produces: a working path where the release run starts for the pushed sha,
  verified by the Task 2 run-started check observing a `release_metadata` run
  with `is-release=true`. The concrete work depends on (d): the
  `GITHUB_TOKEN` + chained `workflow_dispatch` option needs no stored secret
  (the workflow pushes, then dispatches `ci.yml` itself); a PAT / deploy key /
  GitHub App option needs the secret created, stored, its expiry and rotation
  documented here, and (under direct push) a branch-protection bypass actor
  configured. Whichever is chosen, record the exact mechanism in this file when
  implemented.

### Task 4: docs and command update

Interfaces:

- Consumes: the final trigger invocation from Task 2.
- Produces: `.omp/commands/release.md` rewritten from the local-run
  instructions (currently `bun scripts/release.ts $ARGUMENTS` at
  `.omp/commands/release.md:17-19` plus a local retry recipe) to the dispatch
  invocation (`gh workflow run release.yml -f version=...`) and the
  CI-failure retry story; a short "how a release works now" section appended
  to this record.

### Task 5: end-to-end verification

Interfaces:

- Consumes: Tasks 1-4 merged.
- Produces: one canary release cut entirely through the new workflow
  (canary avoids consuming a stable version number), with the full chain
  observed: dispatch, `prepare` push, `ci.yml` release run,
  `release_metadata` reporting `channel=canary`, publish jobs green.

## Tasks

- [ ] Task 1: `prepare` path in `scripts/release.ts`, CLI wiring, check and
  watch steps omitted, empty-`latestTag` guard
- [ ] Task 2: `.github/workflows/release.yml` dispatch workflow with the
  dispatch-ref guard, serialized concurrency, and the run-started check
- [ ] Task 3: main-branch trigger path per Open Question (d)
  (chained dispatch, or a stored credential plus branch-protection bypass)
- [ ] Task 4: `.omp/commands/release.md` and record update
- [ ] Task 5: canary release through the new path

## Open Questions

Maintainer decisions. (a) and (d) are load-bearing: the workflow's shape,
permissions, and secrets all depend on them. (b), (c), and (e) are surfaced
for completeness and can be settled at review.

### (a) Where the bump commit lands (load-bearing)

- **Direct push to `main` by the workflow.** Mirrors today's mechanics
  exactly, just server-side: the same atomic branch-plus-tag push, one CI
  cycle, no extra human step. Needs `contents: write` and a trigger path per
  (d). The genuinely new exposure is a standing branch-protection bypass actor
  for the release workflow: unlike a maintainer's laptop credential, that is a
  permanent, always-on push-to-`main` capability whose blast radius is any
  future compromise of the workflow file.
- **Direct push plus a GitHub Environment with required reviewers on the
  release job.** Same single CI cycle and no tag choreography, but the job
  pauses for one approval click in the Actions UI before it pushes. Restores an
  explicit human gate at the push without the second-CI-cycle and
  squash-rewrites-the-tag costs of the PR option.
- **Release PR the maintainer merges.** The workflow puts the bump commit on
  a branch and opens a PR; the merge to `main` is the human gate, and no bot
  ever pushes to `main`. Costs an extra human step and a second CI cycle, and
  the tag needs care: release detection keys on the commit subject or a tag
  at HEAD (`.github/workflows/ci.yml:74-76`, `:129`), and a squash merge
  rewrites the commit, so this path needs either a merge commit or a
  post-merge step that lays `v${version}` on the merged sha.
- **Recommendation:** direct push. The honest argument is that the local flow
  it replaces was already an unreviewed push to `main` (the local script
  bumps, commits, and pushes straight to `main` with nobody reviewing the
  mechanical version bumps or the changelog rewrite), so a server-side direct
  push is a faithful port of the existing trust model, not a new erosion of a
  review gate that never existed. The one real new cost is the standing bypass
  actor above; if that is unacceptable, the Environments option restores a
  human click at the lowest cost.

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
  release job pushes with the built-in `GITHUB_TOKEN` (`contents: write`), then
  runs `gh workflow run ci.yml --ref main` from the same job. No stored secret,
  no rotation, no expiry cliff. `ci.yml` already accepts `workflow_dispatch`
  (`.github/workflows/ci.yml:59-64`), already schedules any dispatch into the
  never-cancel release group (`.github/workflows/ci.yml:74-76`, third
  disjunct), and `release_metadata` detects the tag at HEAD on a `main`-ref
  dispatch (`fetch-tags` fires for `refs/heads/main`,
  `.github/workflows/ci.yml:114-116`, `:129`). Cost: `workflow_dispatch` pins a
  ref, not a sha, so if a human push lands on `main` between the release push
  and the dispatched checkout, the run executes at the newer untagged tip,
  `release_metadata` reports `is-release=false`, and the release silently does
  not publish. The tag stays on its sha, so a re-dispatch of that sha
  self-heals, and the Task 2 run-started check catches the miss.
- **Fine-grained PAT (or deploy key) push.** A stored `contents: write`
  credential whose push triggers `ci.yml` via the ordinary `on: push` path.
  No ref-vs-sha race. Cost: a long-lived repo-write secret living on the runner,
  a human rotation loop (in tension with the no-manual-steps principle this
  design otherwise honors), an expiry cliff, and under direct push a
  branch-protection bypass configured for the PAT actor.
- **GitHub App installation token.** Best security posture (short-lived
  installation tokens, no expiry cliff), highest setup cost.
- **Recommendation:** the `GITHUB_TOKEN` + chained-dispatch option. It removes
  the standing secret, the rotation loop, and Task 3's PAT plumbing entirely;
  its only cost is the narrow ref-tip race, which is detectable (the Task 2
  run-started check) and self-healing on re-dispatch. Releases are infrequent
  and dispatch-initiated, so the racing-human-push window is small.

### (e) Runner for the release-prepare job

- `omp-kata` (self-hosted, warm caches) versus hosted `ubuntu-22.04` (ships
  `cargo`, no kata-pool queueing). `prepare` compiles nothing, so either works;
  the security angle mildly favors hosted if a stored push credential is chosen
  in (d), since it keeps a repo-write secret off self-hosted infrastructure.
  The `GITHUB_TOKEN` + chained-dispatch option in (d) removes that concern.
- **Recommendation:** hosted `ubuntu-22.04`. `prepare` is a light job and this
  avoids both the kata-pool queue and a secret-on-self-hosted question; revisit
  only if a `prepare` step turns out to need a warm native cache.
