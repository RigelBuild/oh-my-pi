import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getAgentDir,
	getConfigRootDir,
	removeWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

// Captured at module load, before any suite calls `setAgentDir`. The mint suite
// below must restore the shared resolver to this on teardown so later
// full-suite tests never resolve agent paths through a deleted temp dir.
const PRISTINE_AGENT_DIR = getAgentDir();

function silenceStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

// The scrape-scoped `/metrics` token. The broker CLI is the single
// deterministic mint source: it writes the token to `$HOME/.omp/auth-broker-metrics.token`
// (0600, no trailing newline).
describe("auth-broker token --metrics (scrape-scoped mint)", () => {
	let agentDir = "";
	// Snapshot the full resolver-driving env before any override so teardown can
	// restore it. `setAgentDir` mutates the shared dirs resolver AND deletes
	// `OMP_PROFILE`/`PI_PROFILE` while forcing `PI_CODING_AGENT_DIR`; restoring
	// only an agent path would strand a later full-suite test that ran under an
	// active profile on the default profile. Save every var `setAgentDir` touches
	// and rebuild resolver state from the restored env with the reset helper.
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalOmpProfile = process.env.OMP_PROFILE;
	const originalPiProfile = process.env.PI_PROFILE;
	const bearerPath = (): string => path.join(getConfigRootDir(), "auth-broker.token");
	const metricsPath = (): string => path.join(getConfigRootDir(), "auth-broker-metrics.token");

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metrics-token-"));
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		// Restore every var `setAgentDir` mutated, then rebuild the shared resolver
		// from that env so a profile active before this suite survives.
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		__resetDirsFromEnvForTests();
		await removeWithRetries(agentDir);
	});

	test("mints the scrape token to the fixed metrics path, 0600, no trailing newline", async () => {
		const read = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const printed = read();

		const raw = await Bun.file(metricsPath()).text();
		// No trailing newline: the file bytes ARE the bearer value staged verbatim.
		expect(raw).not.toMatch(/\n$/);
		expect(raw.length).toBeGreaterThan(0);
		// The printed token matches the file contents (T2 can read either).
		expect(printed.trim()).toBe(raw);

		const mode = (await fs.stat(metricsPath())).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("is idempotent: a second mint returns the same token", async () => {
		const read1 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const first = read1().trim();

		const read2 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const second = read2().trim();

		expect(second).toBe(first);
		expect(await Bun.file(metricsPath()).text()).toBe(first);
	});

	test("--regenerate rotates the metrics token in place", async () => {
		const read1 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const before = read1().trim();

		const read2 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true, regenerate: true } });
		const after = read2().trim();

		expect(after).not.toBe(before);
		expect(await Bun.file(metricsPath()).text()).toBe(after);
	});

	test("metrics token is independent of the master bearer (distinct files + values)", async () => {
		const readBearer = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: {} });
		const bearer = readBearer().trim();

		const readMetrics = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const metrics = readMetrics().trim();

		// Two distinct files, two distinct random values — the scrape cred is never
		// the vault-authorizing master bearer.
		expect(metrics).not.toBe(bearer);
		expect(await Bun.file(bearerPath()).text()).toBe(bearer);
		expect(await Bun.file(metricsPath()).text()).toBe(metrics);

		// Rotating the master bearer must not touch the metrics token, and vice versa.
		const readRegen = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { regenerate: true } });
		const newBearer = readRegen().trim();
		expect(newBearer).not.toBe(bearer);
		expect(await Bun.file(metricsPath()).text()).toBe(metrics);
	});

	test("emits both token path and value as JSON when --json is set", async () => {
		const read = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true, json: true } });
		const parsed = JSON.parse(read().trim()) as { token: string; path: string };

		expect(parsed.path).toBe(metricsPath());
		expect(parsed.token).toBe(await Bun.file(metricsPath()).text());
	});
});

// Full-suite safety: the mint suite above overrides the shared dirs resolver in
// `beforeEach` and must undo that in `afterEach`. A later suite in the same
// worker relies on the resolver pointing back at the real agent dir; if teardown
// restored only an unrelated env var, this resolves through the deleted temp dir
// instead. Ordering-dependent by design — this must run after the mint suite.
describe("agent-dir resolver is restored after the mint suite", () => {
	test("getAgentDir returns the pristine dir, not a torn-down temp dir", () => {
		expect(getAgentDir()).toBe(PRISTINE_AGENT_DIR);
	});
});

// F3 regression: the mint suite's teardown must restore a profile that was
// active before it ran, not just an agent path. This exercises the exact
// save + restore + resolver-rebuild sequence the suite's afterEach uses. A
// teardown that called only `setAgentDir` (which deletes OMP_PROFILE/PI_PROFILE)
// would strand a later full-suite test on the default profile.
describe("mint-suite teardown restores an active profile", () => {
	test("OMP_PROFILE active before the override is restored after teardown", async () => {
		const ambientOmp = process.env.OMP_PROFILE;
		const ambientPi = process.env.PI_PROFILE;
		const ambientAgent = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.OMP_PROFILE = "auth-broker-metrics-token-profile";
			delete process.env.PI_PROFILE;
			// Suite-body snapshot (what the mint suite captures before any override).
			const savedOmp = process.env.OMP_PROFILE;
			const savedPi = process.env.PI_PROFILE;
			const savedAgent = process.env.PI_CODING_AGENT_DIR;
			// beforeEach override.
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metrics-token-f3-"));
			setAgentDir(tmp);
			expect(process.env.OMP_PROFILE).toBeUndefined();
			// afterEach restore (the fixed sequence).
			restoreEnvValue("PI_CODING_AGENT_DIR", savedAgent);
			restoreEnvValue("OMP_PROFILE", savedOmp);
			restoreEnvValue("PI_PROFILE", savedPi);
			__resetDirsFromEnvForTests();
			await removeWithRetries(tmp);
			expect(process.env.OMP_PROFILE).toBe("auth-broker-metrics-token-profile");
			expect(getActiveProfile()).toBe("auth-broker-metrics-token-profile");
		} finally {
			restoreEnvValue("OMP_PROFILE", ambientOmp);
			restoreEnvValue("PI_PROFILE", ambientPi);
			restoreEnvValue("PI_CODING_AGENT_DIR", ambientAgent);
			__resetDirsFromEnvForTests();
		}
	});
});
