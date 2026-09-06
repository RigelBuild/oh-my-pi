# Auth-broker `/metrics` re-lay (RIG-3358)

## Problem / Intent

The RIG-3144 fork re-sync dropped the auth-broker Prometheus `/metrics` feature (RIG-1242, a Done issue) from this fork, while the orion fleet still scrapes it in production — a live monitoring regression. Restore the feature at fork main, verified by **wiring**, not file existence, and close the test gap that let the regression ship silently.

### Evidence: the feature is gone at fork main

All facts below were read at fork main `08e04cec` ("feat(coding-agent): add --reapply-config … (RIG-3225) (#34)", the current `main@origin` head) against the reference implementation in the orion monorepo subtree `oss/forks/oh-my-pi/` (referred to as "subtree" throughout).

**Line-reference convention (load-bearing for implementers):** a line ref is a property of a **tree**, not of a symbol — the same symbol sits at different lines in the two trees this record cites. Refs labeled **"fork main"** are measured at `origin/main` (`08e04cec`), the tree the re-lay is written AGAINST — these are the numbers an implementer edits at. Refs labeled **"subtree"** are the orion reference implementation (`oss/forks/oh-my-pi/`), the **post-re-lay shape** ported FROM — at fork main those constructs do not exist yet or sit elsewhere. Concretely for the central function: `isAuthorized` is defined at fork main `server.ts:100` (fail-open `:101`) with ONE call site (`:679`, passing `tokens`) and ZERO `metricsTokens` occurrences; in the subtree it is defined at `:110` (fail-open `:111`) with TWO call sites — `:692` passing `metricsTokens` and `:716` passing `tokens`. Neither set of numbers is valid in the other tree.

1. **`packages/ai/src/auth-broker/` has exactly 9 files and no `prometheus-metrics.ts`**: `client.ts`, `discover.ts`, `index.ts`, `refresher.ts`, `remote-store.ts`, `server.ts`, `snapshot-cache.ts`, `types.ts`, `wire-schemas.ts`. The subtree's `prometheus-metrics.ts` (15,390 B) is absent.

2. **`index.ts` lost the export.** Fork main `packages/ai/src/auth-broker/index.ts` (200 B) has 7 `export * from` lines; the subtree copy (238 B) has 8 — the missing one is:

   ```ts
   export * from "./prometheus-metrics";
   ```

3. **`server.ts` lost the route.** Fork main `packages/ai/src/auth-broker/server.ts` (33,002 B) has no `/metrics` handling: request dispatch goes `GET /v1/healthz` (`:675`) → generic `isAuthorized(req, tokens)` gate (`:679`) → the `/v1/*` routes. The subtree copy (35,547 B) additionally carries: the `PROMETHEUS_CONTENT_TYPE, renderUsageMetrics, type SubscriptionLookup` import (`:16`), the `metricsTokens?: string[]` (`:62`) and `subscriptions?: SubscriptionLookup` (`:69`) option fields, the union set

   ```ts
   // Scrape-scoped tokens reach ONLY `/metrics`; master bearers also satisfy it.
   const metricsTokens = new Set<string>([...opts.bearerTokens, ...(opts.metricsTokens ?? [])]);
   ```

   (subtree `:661-662`), and the `GET /metrics` route block (subtree `:691-715`) placed **before** the generic auth gate, checking `isAuthorized(req, metricsTokens)` and rendering via `renderUsageMetrics(reports, { subscriptions: opts.subscriptions })`.

4. **The CLI kept the file but lost the wiring — file existence is NOT an acceptance signal.** `packages/coding-agent/src/cli/auth-broker-cli.ts` exists at fork main at **33,743 B with zero case-insensitive `metric` hits** (grep verified). The subtree copy is **38,693 B** and wires: `getMetricsTokenFilePath()` returning `auth-broker-metrics.token` under the config root (`:107-108`), the second mint in `runServe` — `const metricsToken = await ensureTokenFile(getMetricsTokenFilePath());` (`:262`) — and, in the `startAuthBroker` call, `metricsTokens: [metricsToken],` (`:277`) plus `...(subscriptions ? { subscriptions } : {})` (`:278`). Fork main's `runServe` passes only `bearerTokens: [token]` (`:172`).

5. **`commands/auth-broker.ts` lost the flags.** The subtree copy (4,683 B) declares the `metrics` boolean flag (`:33-35`) and `"subscriptions-config"` string flag (`:55-58`) and threads them at `:93` / `:104`; both are absent from fork main's copy. Additive change.

6. **Four test files are gone**: `packages/ai/test/auth-broker-metrics.test.ts` (23,894 B), `packages/ai/test/auth-broker-metrics-route.test.ts` (3,928 B), `packages/coding-agent/test/auth-broker-metrics-token.test.ts` (4,806 B), `packages/coding-agent/test/auth-broker-config.test.ts` (3,242 B — imports only `parseSubscriptionsConfig` (`:2`), zero `metric` hits: it is subscriptions-config coverage, not metrics coverage). Fork main's `packages/ai/test/` and `packages/coding-agent/test/` contain none of them (verified by listing `auth-broker*` there).

### Why no gate saw the break

- **CI is structurally blind.** The regression is a missing HTTP route, not a build error: nothing at fork main imports the deleted module, so `tsgo`/build stay green; the deleted tests can't fail because they were deleted with the feature.
- **Production consumes it silently.** orion's Alloy scrapes the broker at `127.0.0.1:4002` with a sops-staged scrape token — `infra/nix/nixos/mattfw/system.nix:367-370`:

  ```nix
  orion.alloy.scrapes.auth_broker = {
    endpoint = "127.0.0.1:4002";
    tokenSopsSecret = config.sops.secrets."auth-broker-metrics-token".path;
  };
  ```

  A 404 on the scrape is not a nix failure and not a build failure. The `llm_usage_limit_*` families feed Grafana alert rules in `infra/pulumi/platform/grafana/index.ts` (e.g. `LlmFleetPoolNearCapDurable` `:1026`, `LlmFleetWorkStoppage` `:1075`). The only detector is the runtime absence alert `LlmUsageMetricsAbsent` — `expr: 'absent(llm_usage_limit_used_fraction{provider="anthropic"})'` (`:1127-1128`, 30 m) — which fires **after** the regression ships, in production. Nothing pre-merge can see it.
- **The mint→consume seam was never tested** (see Approach), so even re-running every restored test would not have caught the exact wiring deletion that occurred.

## Approach

Port the feature from the subtree reference into fork main as a hand-port of the metrics hunks — **not** a wholesale file copy — because the destination has drifted, then add a **mint→consume seam test** plus a **route-level fail-open guard test** that the original test set lacked.

### The fork is the fix site

- Upstream `can1357/oh-my-pi` PR **#10290** (the origin of this feature; verified via the PR record this session) is **OPEN**, base `main`, merge state `DIRTY` — the feature does not exist upstream, so no upstream sync can restore it.
- The push-guard makes an upstream PR unexecutable by any agent (allowlisted owners only; precedent RIG-3225), so upstreaming is not an available path even if desired.
- orion consumes the fork's binary; the subtree under `oss/forks/oh-my-pi/` is pre-reset lineage kept as reference. The fork is where production behavior is defined.

### Hand-port, not copy: destination drift

Fork main's history was reset onto upstream lineage; the auth-broker has drifted from the subtree in ways that make byte-copying the subtree files wrong:

- `server.ts` at fork main imports `{ type Type, type } from "@oh-my-pi/omptype"` where the subtree uses `arktype`, imports wire schemas directly from `./wire-schemas` where the subtree calls `getAuthBrokerWireSchemas()`, and `await`s `opts.storage.invalidateUsageCache?.()` where the subtree does not (all seen in the subtree↔fork diff this session). Only the metrics hunks (Problem §3) move; everything else stays fork-main-shaped.
- `runServe` at fork main constructs `new AuthStorage(store, { refreshOAuthCredential: … refreshBrokerOAuthCredential … })` (`packages/coding-agent/src/cli/auth-broker-cli.ts:164-167`, the issue #8933 MCP-refresh fix) where the subtree passes `new AuthStorage(store)` (`:265`). The port MUST preserve fork main's construction and only add the mint + options.
- Fork main's CLI token helpers are path-less (`readToken()`/`writeToken()`/`ensureToken()` hardwired to `getTokenFilePath()`, `:92-124`); the subtree generalized them to file-parameterized `readTokenFile(file)`/`writeTokenFile(file, token)`/`ensureTokenFile(file)` (`:111-145`) to serve both tokens. The port adopts the subtree's generalized shape (the restored token test depends on its behavior: 0600, no trailing newline).

The four test files and `prometheus-metrics.ts` itself are drift-free ports: `prometheus-metrics.ts` imports only `../usage` (subtree `:15-16`), and every import the tests use exists at fork main — `@oh-my-pi/pi-ai/auth-broker` subpath export (`packages/ai/package.json:49-55`), `@oh-my-pi/pi-ai/usage` (25 existing files at both sides import it), `removeWithRetries` (`packages/utils/src/temp.ts:90`), `runAuthBrokerCommand` (fork main CLI `:951`).

### The auth model, stated precisely (it shapes the tests)

Fork main `server.ts:100-106`:

```ts
function isAuthorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	return tokens.has(match[1].trim());
}
```

- **The empty-set fail-open is ambient, not introduced by this re-lay.** `if (tokens.size === 0) return true;` sits at fork main today with zero `metricsTokens` occurrences anywhere in the file — it predates and is independent of the metrics work, and it governs the vault routes too.
- **But the re-lay WIDENS RIG-3359's blast radius — the two issues are coupled, not independent.** At fork main the fail-open branch has exactly one caller (`:679`, the vault-route gate). The re-lay adds a second call site — the metrics route, passing a **different** token set through the **same** fail-open branch (subtree `:692`) — and that metrics set is precisely the one that is empty when `serve` fails to wire the minted scrape token, i.e. the exact regression this re-lay fixes. So today the fail-open governs one route; after RIG-3358 it governs two. This coupling is why Test B's characterization is **tripwired** to flip 200 → 401 the moment RIG-3359 lands (Task 4 clause 5), rather than the flip being an unanchored deferral: the re-lay itself increases the exposure the tripwire watches.
- **The metrics set deliberately unions in the master bearers** (subtree `:661-662`, quoted in Problem §3). The least-privilege claim (subtree CLI `:100`) is one-directional: a scrape token never reaches the vault routes; `/metrics` accepts either credential. A test asserting master → 401 would fail against correct code and pin a boundary the design does not claim.
- **The fail-open is structurally unreachable through the CLI `serve` path.** Subtree CLI `:139-145`: `ensureTokenFile` cannot return empty (`if (existing) return existing;` else `generateToken()` + write), and `runServe` always passes `bearerTokens: [token]` (`:276`) — so on `serve` the master set has size ≥ 1 and the metrics union inherits it. A garbage-bearer request through `serve` exercises the `tokens.has(…)` rejection branch, **never** the `tokens.size === 0` branch. This is why the coverage splits into two tests (below): mislabeling a CLI-path 401 case as "covers the fail-open" would be the exact justification a later refactor uses to delete the only real fail-open guard as redundant.
- Consequence of the union: the metrics set is non-empty whenever the master set is, so the shipped regression (unwired `metricsTokens`, master still wired) yields **401** on the minted scrape bearer, not a fail-open 200. Fail-open requires **both** sets empty — reachable only by direct server construction.

### The seam test is load-bearing, not belt-and-braces

The two restored suites bracket the mint→consume seam without crossing it:

- **Mint side**: every case in `auth-broker-metrics-token.test.ts` drives `runAuthBrokerCommand({ action: "token", … })` (`:44, :60, :64, :73, :77, :86, :90, :101, :109`); `action: "serve"` never appears in the file.
- **Consume side**: `auth-broker-metrics-route.test.ts` builds the server directly via `startAuthBroker` with hardcoded credentials — `bearerTokens: [MASTER]` (`:49`), `metricsTokens: [SCRAPE]` (`:50`) — never reaching the CLI's `metricsTokens: [metricsToken]` wiring.

So deleting `metricsTokens: [metricsToken]` from the CLI leaves **both** suites green while every production scrape 401s — which is precisely the class of regression that shipped. And because upstream #10290 is still OPEN, a future re-sync can reintroduce the loss the same way; only a committed test that fails on the unwired seam survives that, a pre-merge checklist item does not.

The route test does assert 401/no-header/master cases (`:74-83`) — but only against the directly-constructed server, and it has no empty-token-set case. Through the CLI serve path all four seam cases are net-new, and the fail-open guard (Test B) is net-new at any level.

## Plan

Ordering: the `packages/ai` slice first (renderer + server + its two tests are self-contained), then the `packages/coding-agent` slice (CLI + command + its two tests, depends on the `pi-ai` exports), then the two new tests (depend on both), then changelogs + targeted verification.

**Conflict re-verification (current base).** The previously predicted conflict — a one-line `Map` annotation in `eval-code-mode-declarations.test.ts` — was made against v18.1.7 and **no longer applies**: at the current base the file lives at `packages/coding-agent/test/eval-code-mode-declarations.test.ts` with `Map<…>` annotations already present at `:132` and `:156`, and it has **no subtree counterpart** (glob over the subtree finds none). Since this re-lay is a hand-port of new/modified files rather than a subtree merge, there is no merge machinery to conflict; no other conflicts are predicted. If `jj` reports any conflict during the work, that is a signal the base moved — stop and re-ground.

**Verification per layer** (targeted only — no project-wide suites, per the fork's convention of scoped checks):

- Layer 1 (`packages/ai`): `bun test packages/ai/test/auth-broker-metrics.test.ts packages/ai/test/auth-broker-metrics-route.test.ts`.
- Layer 2 (`packages/coding-agent`): `bun test packages/coding-agent/test/auth-broker-metrics-token.test.ts packages/coding-agent/test/auth-broker-config.test.ts`.
- Layer 3 (new tests): run Test A + Test B; then the **red-check** — temporarily delete `metricsTokens: [metricsToken],` from `runServe`, observe A1 fail, restore, observe green. The red-check is an acceptance criterion, not optional.
- Wiring greps as cheap invariants at each step (exact patterns in Tasks).

## Global Constraints

- Runtime: Bun; tests are `bun:test`. No new dependencies (`prometheus-metrics.ts` is dependency-free by design).
- Destination conventions win over subtree conventions everywhere they differ: `@oh-my-pi/omptype` (not `arktype`), direct `./wire-schemas` imports (not `getAuthBrokerWireSchemas()`), fork main's `AuthStorage(store, { refreshOAuthCredential … })` construction preserved.
- Verification is file-targeted: named test files, per-package `tsgo --noEmit` / `biome check` at most. No project-wide suites, formatters, or linters.
- Do not touch the orion monorepo or `can1357/oh-my-pi`.
- The union semantics of the metrics token set (master bearers satisfy `/metrics`) are a frozen design decision — no task may "tighten" it.
- The ambient `tokens.size === 0` fail-open is pre-existing upstream behavior; this re-lay pins it (Test B) but does not change it (see the deferred item under Open Questions).
- Every new test's docstring MUST name which branch of `isAuthorized` (fork main `server.ts:100-106`) it pins, so the branch↔test mapping is checkable rather than inferred from test names.
- **Both net-new tests carry a required red-check** proving they observe the real thing: Test A's wiring red-check (delete `metricsTokens: [metricsToken]` → A1 fails, Task 3) and Test B's execution-proof red-check (invert the expectation → status-mismatch failure, Task 4). A test green because it never ran — a renamed symbol or wrong arity throwing before the assertion — reads identically to a passing test in suite output and is worse than an absent one.
- **Report verification numbers with the commit they were measured at**: run `jj log -r @` first and state "N pass at `<sha>`" — a green count measured against the wrong tree (e.g. after a rebase moved `@`) manufactures agreement instead of evidence.
- Line refs follow the per-tree convention in Problem — fork-main numbers are where implementers edit; subtree numbers describe the source being ported and the post-re-lay shape. Never cite either unqualified.

## Tasks

### Task 1 — `packages/ai` slice: renderer, server route, exports, unit + route tests

**Files:**
- ADD `packages/ai/src/auth-broker/prometheus-metrics.ts` — verbatim from subtree (15,390 B; imports only `../usage`, which exists at fork main: `UsageLimit`/`UsageReport`/`UsageStatus`/`resolveUsedFraction` at `packages/ai/src/usage.ts:11,60,104,126`).
- EDIT `packages/ai/src/auth-broker/index.ts` — add `export * from "./prometheus-metrics";` in sorted position.
- EDIT `packages/ai/src/auth-broker/server.ts` — port exactly four hunks onto the fork-main shape:
  1. import `{ PROMETHEUS_CONTENT_TYPE, renderUsageMetrics, type SubscriptionLookup } from "./prometheus-metrics"` beside the existing `./refresher` import;
  2. add `metricsTokens?: string[]` and `subscriptions?: SubscriptionLookup` option fields (with the subtree's doc comments) after `bearerTokens: string[]` (fork main `:59`);
  3. add the union set `const metricsTokens = new Set<string>([...opts.bearerTokens, ...(opts.metricsTokens ?? [])]);` after `const tokens = new Set<string>(opts.bearerTokens);` (fork main `:650`);
  4. insert the `GET /metrics` route block (subtree `:691-715` content) after the `/v1/healthz` block (fork main `:675-678`) and **before** the generic `isAuthorized(req, tokens)` gate (fork main `:679`). Uses the existing `empty()` helper (fork main `:96`).
- ADD `packages/ai/test/auth-broker-metrics.test.ts` and `packages/ai/test/auth-broker-metrics-route.test.ts` — verbatim from subtree.

**Interfaces:** produces `renderUsageMetrics(reports: readonly UsageReport[], opts): string`, `PROMETHEUS_CONTENT_TYPE`, `accountLabelOf`, `emailLabelOf`, `nextRenewalSeconds`, `UNIDENTIFIED_ACCOUNT`, `interface SubscriptionLookup` via `@oh-my-pi/pi-ai/auth-broker`; `startAuthBroker` gains `metricsTokens?: string[]` and `subscriptions?: SubscriptionLookup`.

**Acceptance (wiring-based):**
- `grep -c 'pathname === "/metrics"' packages/ai/src/auth-broker/server.ts` ≥ 1 and `grep 'metricsTokens' packages/ai/src/auth-broker/server.ts` shows both the option field and the union set.
- `grep 'prometheus-metrics' packages/ai/src/auth-broker/index.ts` shows the export.
- Both named test files pass under `bun test`.
- `tsgo --noEmit` clean for `packages/ai`.

### Task 2 — `packages/coding-agent` slice: CLI dual-token wiring, command flags, token + config tests

**Files:**
- EDIT `packages/coding-agent/src/cli/auth-broker-cli.ts`:
  - generalize token helpers to the subtree's file-parameterized shape (`readTokenFile`/`writeTokenFile`/`ensureTokenFile`, subtree `:111-145` — preserving 0600, `mkdir` 0700, **no trailing newline**) and add `getMetricsTokenFilePath()` → `path.join(getConfigRootDir(), "auth-broker-metrics.token")` (subtree `:107-108`);
  - add the subscriptions-config machinery: `SUBSCRIPTIONS_ENV = "OMP_AUTH_BROKER_SUBSCRIPTIONS"`, `loadSubscriptionsConfig()`, exported `parseSubscriptionsConfig(raw, file)` (subtree `:147-190`), plus `type SubscriptionLookup` import from `@oh-my-pi/pi-ai/auth-broker`;
  - in `runServe`: mint the second token (`const metricsToken = await ensureTokenFile(getMetricsTokenFilePath());`), load subscriptions, and extend the `startAuthBroker` call with `metricsTokens: [metricsToken],` and `...(subscriptions ? { subscriptions } : {})` — **keeping fork main's `AuthStorage(store, { refreshOAuthCredential … })` construction (`:164-167`) intact**; add the "metrics token loaded" log line (subtree `:283`);
  - in `runToken`: route on `flags.metrics` to the metrics file (subtree `:303-323` shape);
  - extend `AuthBrokerCommandArgs["flags"]` with `metrics?: boolean` and `subscriptionsConfig?: string`.
- EDIT `packages/coding-agent/src/commands/auth-broker.ts` — add the `metrics` boolean flag and `"subscriptions-config"` string flag with the subtree's descriptions (`:33-35`, `:55-58`), thread them into the command args (`:93`, `:104`), and add the two `--metrics` example lines (`:66-67`). Additive only.
- ADD `packages/coding-agent/test/auth-broker-metrics-token.test.ts` and `packages/coding-agent/test/auth-broker-config.test.ts` — verbatim from subtree. (The config test is subscriptions coverage, not metrics coverage — restored because `parseSubscriptionsConfig` returns with this task.)

**Interfaces:** consumes `SubscriptionLookup` from Task 1. Produces `parseSubscriptionsConfig` (exported) and the CLI behaviors the tests pin: `token --metrics` mints/reads `auth-broker-metrics.token` (0600, no trailing newline, idempotent, `--regenerate` rotates independently of the master bearer, `--json` shape `{ token, path }`).

**Acceptance (wiring-based):**
- `grep -F 'metricsTokens: [metricsToken]' packages/coding-agent/src/cli/auth-broker-cli.ts` matches — this exact line is the load-bearing wiring whose deletion shipped the regression.
- Both named test files pass under `bun test`.
- `tsgo --noEmit` clean for `packages/coding-agent`.

### Task 3 — Test A: CLI-path mint→consume seam test + serve-core extraction (net-new, REQUIRED)

**Files:** EDIT `packages/coding-agent/src/cli/auth-broker-cli.ts` (the extraction below); ADD `packages/coding-agent/test/auth-broker-serve-metrics-seam.test.ts`.

**Mechanism (frozen — OQ1 ruled, option (a)): extract a testable core from `runServe`.**

- Split `runServe` into an exported core, named **`startAuthBrokerService(flags)`** — everything through the `startAuthBroker` call plus the two "token loaded" log lines, returning `{ handle, storage, close }`. Do NOT name a production symbol "ForTest": the test-only affordance is that the core **returns** instead of blocking, not its name.
- `runServe` becomes a thin blocking wrapper over the core that retains, verbatim:
  - the **signal handlers** (`process.once("SIGINT"/"SIGTERM")`, fork main `:189-190`);
  - the **`credentialDisabledUnsub()` teardown** on shutdown (fork main `:184`) — the disabled-credential warning subscription must still be released;
  - **`process.exit(0)`** in the wrapper's shutdown (fork main `:187`) — never in the core, or the seam test kills the runner;
  - the **forever-await** `await new Promise<never>(() => {})` (fork main `:193`).
- The core MUST preserve fork main's `new AuthStorage(store, { refreshOAuthCredential: … refreshBrokerOAuthCredential … })` construction (`:164-167`, the issue #8933 MCP-refresh fix) — do NOT regress to the subtree's bare `new AuthStorage(store)` (`:265`).

**Accepted risk (stated per the ruling):** this refactor touches the very control flow the seam test exists to protect — a mistake in the extraction is a mistake in the thing under test. Mitigation is the red-check ordering below: the red-check runs **after** the extraction, proving the test observes the real wiring through the refactored path rather than an artifact of the harness.

**Question the test answers:** does `serve` wire the minted scrape token into the server? Mint via the CLI (`runAuthBrokerCommand({ action: "token", flags: { metrics: true } })` against an isolated `OMP_AGENT_DIR`, as the token test does at `:29-33`), start the broker in-process via `startAuthBrokerService`, scrape `http://<bind>/metrics`, and assert four cases:

- **A1. minted scrape bearer → 200** — catches unwired `metricsTokens` (the shipped regression). Docstring: pins the `tokens.has(…)` acceptance branch through the CLI wiring.
- **A2. garbage/wrong bearer → 401** — docstring MUST state: pins the `tokens.has(…)` **rejection** branch, and explicitly that this does **NOT** cover the `tokens.size === 0` fail-open, because `serve` always mints (`ensureTokenFile` cannot return empty, subtree `:139-145`; `bearerTokens: [token]` at `:276`), so `tokens.size >= 1` always holds via the CLI. Test B owns the fail-open.
- **A3. no `Authorization` header → 401** — docstring: pins the `!header` branch (fork main `server.ts:103`).
- **A4. master bearer (read from `auth-broker.token`) → 200** — docstring: pins the deliberate union (subtree `server.ts:661-662`) so a future "tighten least-privilege" refactor must confront the design instead of silently breaking the fleet's master-bearer path.

**Acceptance:**
- Test A passes under `bun test`; each case's docstring names its `isAuthorized` branch per Global Constraints.
- **Red-check (required, run AFTER the extraction):** temporarily delete the line `metricsTokens: [metricsToken],` from the extracted core in `packages/coding-agent/src/cli/auth-broker-cli.ts` → **A1 MUST fail** (expected observation: 401 on the minted scrape bearer, per the union analysis in Approach) → restore the line → all four cases green again. The PR description must state the red-check was performed and what failed.
- **Wrapper behavior-preservation (reviewed-by-inspection):** the wrapper still blocks forever, still installs both signal handlers, still runs `credentialDisabledUnsub()` and exits 0 on SIGTERM. This CANNOT be asserted in-process without the subprocess harness the ruling rejected (asserting `process.exit` requires surviving it), so it is explicitly a reviewed-by-inspection item, NOT test coverage: the implementer states in the PR that the wrapper diff is signal-handler + teardown + forever-await only, and the reviewer confirms the wrapper contains no logic beyond delegation to the core.

### Task 4 — Test B: route-level fail-open characterization test (net-new, REQUIRED)

**File:** ADD the case to `packages/ai/test/auth-broker-metrics-route.test.ts` (it already owns direct-construction `/metrics` auth cases at `:63-88`) as a separately-constructed server case — or a sibling test file if fixture sharing is awkward; implementer's choice, same package either way.

**Question the test answers:** is the `tokens.size === 0` fail-open (fork main `server.ts:101`) live on `/metrics`? Construct the server **directly** — `startAuthBroker({ …, bearerTokens: [], metricsTokens: [] })` — then `GET /metrics` with no credentials. **Assert 200**: under current semantics the fail-open authorizes the request, and this test *characterizes* that current behavior (a MUST-401 assertion would be red-on-arrival against correct-per-current-semantics code, and fixing it would require changing `isAuthorized` — which would launder the RIG-3359 decision, deferred to a human ruling, into this regression-restore).

**Neutralizing the endorsement hazard** — a bare `expect(res.status).toBe(200)` on an unauthenticated endpoint reads as an endorsement of fail-open. Neutralize it in the test *name and docstring*, not a trailing comment:

- **Name**: a characterization of CURRENT behavior carrying both the word "currently" and the issue ref, e.g. `"empty token sets currently fail OPEN — GET /metrics serves unauthenticated (RIG-3359)"`.
- **Docstring**, stating in this order: (1) this pins CURRENT behavior, NOT desired behavior; (2) the mechanism — `server.ts:100-101` `if (tokens.size === 0) return true;` — is ambient at fork main, independent of the metrics work, so the re-lay neither introduces nor endorses it; (3) the same branch governs the VAULT routes, so an empty `bearerTokens` serves credential endpoints unauthenticated; (4) flipping to fail-closed is tracked in RIG-3359 and is a human call; (5) when RIG-3359 lands, THIS TEST MUST FLIP to expect 401 — its failure at that point is the intended signal, not a regression.

Clause (5) is what makes the characterization load-bearing rather than merely descriptive: the test is the tripwire that makes a future fail-closed change visible, failing the moment someone changes the default — the same rationale that earns case A4 (master → 200) its place. The tripwire is not optional politeness: the re-lay itself adds the second `isAuthorized` call site that widens the fail-open's blast radius (see Approach), so this change is what makes the RIG-3359 exposure larger — it owes the alarm.

**Acceptance:**
- Test B passes under `bun test`; its name and docstring satisfy the neutralization spec above, name the `tokens.size === 0` branch, and state the CLI-unreachability rationale (see Approach).
- **Execution-proof red-check (required):** show the test actually REACHES its assertion, not merely that the file is green — temporarily invert the expectation (`expect(res.status).toBe(401)`) → the test MUST fail with a status-mismatch (`received 200`), proving the request executed and the assertion ran → restore → green. A test that throws before its assertion (renamed symbol, wrong arity, unreachable fixture) reads as green in a passing suite while never having executed once; a green-because-never-ran test is worse than an absent one. The PR description must state this check was performed and what the inverted failure showed.

### Task 5 — changelogs + targeted verification sweep

**Files:** EDIT `packages/ai/CHANGELOG.md` and `packages/coding-agent/CHANGELOG.md` (both exist at fork main) — one entry each for the restored `/metrics` endpoint and dual-token CLI, referencing RIG-3358.

**Acceptance:** changelog entries present; `tsgo --noEmit` and `biome check` clean for the two touched packages; all test files from Tasks 1–4 pass in one `bun test <files…>` invocation.

## Open Questions

### OQ2 (surfaced and deferred — explicitly out of scope for this re-lay)

**The ambient `tokens.size === 0` fail-open** (fork main `server.ts:101`) predates the metrics work and governs the **vault routes** too: an empty `bearerTokens` would serve credential endpoints unauthenticated. Test B *characterizes* the current behavior for `/metrics` only (asserting 200, the observable the fail-open produces — see Task 4). Whether the default should be fail-closed is a security-posture question about pre-existing upstream behavior, outside a re-lay's scope; it is tracked separately as **RIG-3359** for a human ruling. This record deliberately does not change it — but note the coupling stated in Approach: the re-lay **widens** RIG-3359's blast radius by adding the second `isAuthorized` call site (metrics route, subtree `:692`), taking the fail-open from one governed route to two, and the newly governed set is exactly the one left empty by the regression this record fixes. RIG-3358 and RIG-3359 are not independent findings side by side. When RIG-3359 lands, Test B flips to expect 401 as its intended signal.

### Resolved during design (recorded, not open)

- **Master bearer must NOT be asserted → 401 on `/metrics`.** The union is deliberate (subtree `server.ts:661-662`); least-privilege is one-directional. Case A4 pins it as intentional.
- **OQ1 RULED (human decision): the seam test drives `serve` via an extracted core, not a subprocess.** `runServe` was structurally untestable in-process — it ends with `await new Promise<never>(() => {})` and its shutdown calls `process.exit(0)` (fork main `cli/auth-broker-cli.ts:182-194`; the subtree has the same shape at `:289-301`, presumably why the original test set never crossed this seam). The alternative (a `Bun.spawn` subprocess harness polling `/v1/healthz` then SIGTERM) was rejected: slower, signal/teardown-flaky, and a heavier harness for the same four assertions. The frozen mechanism, name (`startAuthBrokerService`), wrapper-preservation constraints, the accepted extraction risk, and its red-check-after-extraction mitigation are specified in Task 3.
- **Test B asserts 200 (characterization), not 401 (aspiration).** A MUST-401 assertion would be red-on-arrival against correct-per-current-semantics code — the next person deletes it or "fixes" it by changing `isAuthorized`, silently pulling the RIG-3359 posture decision into a regression-restore. Asserting current behavior with the Task-4 neutralization spec (name + ordered docstring + flip-on-RIG-3359 clause) keeps the test green today and makes it the tripwire for any future default change.
- **A CLI-path 401 case must not be labeled as fail-open coverage.** The fail-open is unreachable through `serve` (`ensureTokenFile` cannot return empty, subtree `:139-145`); a mislabel would be the justification a later refactor uses to delete the real guard as redundant. Hence the A2/Test-B split and the docstring-names-the-branch constraint.
- **The predicted `eval-code-mode-declarations.test.ts` conflict is void at the current base** (see Plan) — the prediction predates the fork's history reset; the file has no subtree counterpart and the re-lay is a hand-port, not a merge.
- **`types.ts` is not in the port set** — confirmed: the fork↔subtree diff for `packages/ai/src/auth-broker/types.ts` is empty (byte-identical), and the subtree's metrics types live in `prometheus-metrics.ts` and `server.ts`.
