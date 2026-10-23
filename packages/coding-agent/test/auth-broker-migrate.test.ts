import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { getAgentDbPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const TEAM_ORG = "org-team-1111";

async function runMigrateCapturingStdout(options: { includeEnv?: boolean } = {}): Promise<string> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAuthBrokerCommand({
			action: "migrate",
			flags: { fromLocal: true, includeOauth: true, includeEnv: options.includeEnv },
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured;
}

describe("auth-broker migrate", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-migrate-bearer";
	// `setAgentDir()` installs a process-wide agent dir (and writes
	// PI_CODING_AGENT_DIR); without a restore it leaked this suite's
	// since-deleted temp dir into every later suite in the same worker.
	let settingsState: SettingsTestState | undefined;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		savedEnv.OMP_AUTH_BROKER_URL = process.env.OMP_AUTH_BROKER_URL;
		savedEnv.OMP_AUTH_BROKER_TOKEN = process.env.OMP_AUTH_BROKER_TOKEN;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-migrate-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-migrate-broker-"));
		setAgentDir(agentDir);

		brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		process.env.OMP_AUTH_BROKER_URL = handle.url;
		process.env.OMP_AUTH_BROKER_TOKEN = token;
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		await removeWithRetries(agentDir);
		await removeWithRetries(brokerAgentDir);
		for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("rerun skips an already-migrated org-only row instead of re-uploading a stale refresh token", async () => {
		// Local row where login recovered neither email nor account: the org id
		// is the only identity the broker snapshot can echo back.
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential("anthropic", {
				type: "oauth",
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
				orgId: TEAM_ORG,
				orgName: "Team",
			});
		} finally {
			localStore.close();
		}

		const firstRun = await runMigrateCapturingStdout();
		expect(firstRun).toContain("uploaded");
		const uploaded = brokerStore!.getOAuth("anthropic");
		expect(uploaded?.refresh).toBe("refresh-local-stale");
		expect(uploaded?.orgId).toBe(TEAM_ORG);

		// The broker rotates the token after migration — its copy is now newer
		// than the local one.
		await brokerStore!.upsertAuthCredential("anthropic", {
			type: "oauth",
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 7_200_000,
			orgId: TEAM_ORG,
			orgName: "Team",
		});
		await brokerStorage!.credentials.reload();

		// Rerun: the org-only row must be recognized as already migrated, not
		// re-uploaded (which would clobber the broker's newer refresh token).
		const secondRun = await runMigrateCapturingStdout();
		expect(secondRun).toContain("already on broker");
		expect(secondRun).toContain("Nothing to migrate");
		const persisted = brokerStore!.getOAuth("anthropic");
		expect(persisted?.refresh).toBe("refresh-rotated");
		expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(1);
	});

	test("uploads distinct local API keys for the same provider", async () => {
		const keys = ["sk-ant-api03-local-credential-0001", "sk-ant-api03-local-credential-0002"];
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			for (const key of keys) await localStore.upsertAuthCredential("anthropic", { type: "api_key", key });
		} finally {
			localStore.close();
		}

		const output = await runMigrateCapturingStdout();
		expect(output.match(/uploaded \[local-sqlite\] anthropic/g)).toHaveLength(2);
		expect(output).toContain("…0001");
		expect(output).toContain("…0002");
		for (const key of keys) expect(output).not.toContain(key);
		const brokerKeys = brokerStore!
			.listAuthCredentials("anthropic")
			.map(row => (row.credential.type === "api_key" ? row.credential.key : undefined))
			.filter((key): key is string => key !== undefined);
		expect(brokerKeys).toEqual(expect.arrayContaining(keys));
		expect(brokerKeys).toHaveLength(2);
	});

	test("skips only the exact API key already on the broker", async () => {
		const existingKey = "sk-ant-api03-broker-credential-0001";
		const newKey = "sk-ant-api03-local-credential-0002";
		await brokerStore!.upsertAuthCredential("anthropic", { type: "api_key", key: existingKey });
		await brokerStorage!.credentials.reload();
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential("anthropic", { type: "api_key", key: existingKey });
			await localStore.upsertAuthCredential("anthropic", { type: "api_key", key: newKey });
		} finally {
			localStore.close();
		}

		const output = await runMigrateCapturingStdout();
		expect(output).toContain("already on broker");
		expect(output.match(/uploaded \[local-sqlite\] anthropic/g)).toHaveLength(1);
		expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(2);
	});

	test("env keys deduplicate against the exact local key already planned", async () => {
		const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
		const brokerKey = "sk-ant-api03-broker-credential-0001";
		const plannedKey = "sk-ant-api03-local-credential-0002";
		try {
			process.env.ANTHROPIC_API_KEY = plannedKey;
			await brokerStore!.upsertAuthCredential("anthropic", { type: "api_key", key: brokerKey });
			await brokerStorage!.credentials.reload();
			const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				await localStore.upsertAuthCredential("anthropic", { type: "api_key", key: plannedKey });
			} finally {
				localStore.close();
			}

			const output = await runMigrateCapturingStdout({ includeEnv: true });
			expect(output).toContain("already planned");
			expect(output.match(/uploaded \[local-sqlite\] anthropic/g)).toHaveLength(1);
			expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(2);
			expect(
				brokerStore!
					.listAuthCredentials("anthropic")
					.some(row => row.credential.type === "api_key" && row.credential.key === plannedKey),
			).toBe(true);
		} finally {
			if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
		}
	});

	test("uploads an env key when the broker has a different API key", async () => {
		const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
		const brokerKey = "sk-ant-api03-broker-credential-0001";
		const envKey = "sk-ant-api03-env-credential-0002";
		try {
			process.env.ANTHROPIC_API_KEY = envKey;
			await brokerStore!.upsertAuthCredential("anthropic", { type: "api_key", key: brokerKey });
			await brokerStorage!.credentials.reload();

			const output = await runMigrateCapturingStdout({ includeEnv: true });
			expect(output).toContain("uploaded [env] anthropic");
			expect(output).toContain("…0002");
			expect(output).not.toContain(envKey);
			const anthropicKeys = brokerStore!
				.listAuthCredentials("anthropic")
				.map(row => (row.credential.type === "api_key" ? row.credential.key : undefined))
				.filter((key): key is string => key !== undefined);
			expect(anthropicKeys).toEqual(expect.arrayContaining([brokerKey, envKey]));
			expect(anthropicKeys).toHaveLength(2);
		} finally {
			if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
		}
	});

	test("skips an env key that exactly matches a broker API key", async () => {
		const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
		const brokerKey = "sk-ant-api03-shared-credential-0001";
		try {
			process.env.ANTHROPIC_API_KEY = brokerKey;
			await brokerStore!.upsertAuthCredential("anthropic", { type: "api_key", key: brokerKey });
			await brokerStorage!.credentials.reload();

			const output = await runMigrateCapturingStdout({ includeEnv: true });
			expect(output).toContain("skip [env] anthropic (api key …0001): already on broker");
			expect(output).not.toContain("uploaded [env] anthropic");
			expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(1);
		} finally {
			if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
		}
	});

	test.each([
		{
			provider: "google-antigravity",
			shared: "project",
			identity: { projectId: "aicode-consumers" },
			local: ["alice@gmail.com", "bob@gmail.com"],
		},
		{
			provider: "openai-codex",
			shared: "workspace",
			identity: { accountId: "ws-team-2222", orgId: "ws-team-2222" },
			local: ["alice@example.com"],
		},
	])(
		"uploads $provider accounts that only share a $shared id with an account on the broker",
		async ({ provider, identity, local }) => {
			const oauth = (email: string, refresh: string) => ({
				type: "oauth" as const,
				access: `access-${email}`,
				refresh,
				expires: Date.now() + 3_600_000,
				email,
				...identity,
			});
			await brokerStore!.upsertAuthCredential(provider, oauth("carol@example.com", "refresh-broker-carol"));
			await brokerStorage!.credentials.reload();
			const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				for (const email of local) {
					await localStore.upsertAuthCredential(provider, oauth(email, `refresh-local-${email}`));
				}
			} finally {
				localStore.close();
			}

			await runMigrateCapturingStdout();
			expect(brokerStore!.listAuthCredentials(provider).map(row => row.credential)).toMatchObject([
				{ email: "carol@example.com", refresh: "refresh-broker-carol" },
				...local.map(email => ({ email, refresh: `refresh-local-${email}` })),
			]);
		},
	);

	test.each([
		{
			// Stored before its email was recovered, so keyed by account: uploading the
			// local row would claim it and overwrite the broker's token.
			held: "an email-less row keyed by account",
			provider: "anthropic",
			onBroker: { accountId: "acct-3333", orgId: TEAM_ORG, orgName: "Team" },
			local: { email: "alice@example.com", accountId: "acct-3333", orgId: TEAM_ORG, orgName: "Team" },
		},
		{
			// Only the local row carries an account id, so the store keys the two apart:
			// uploading would add a second row for the same account.
			held: "a row keyed by email while the local one is keyed by account",
			provider: "google-antigravity",
			onBroker: { email: "alice@gmail.com", projectId: "aicode-consumers" },
			local: { email: "alice@gmail.com", accountId: "acct-4444", projectId: "aicode-consumers" },
		},
	])("keeps the broker's newer token for an account it holds as $held", async ({ provider, onBroker, local }) => {
		await brokerStore!.upsertAuthCredential(provider, {
			type: "oauth",
			...onBroker,
			access: "access-broker",
			refresh: "refresh-broker-newer",
			expires: Date.now() + 7_200_000,
		});
		await brokerStorage!.credentials.reload();
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential(provider, {
				type: "oauth",
				...local,
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
			});
		} finally {
			localStore.close();
		}

		const output = await runMigrateCapturingStdout();
		expect(output).toContain("already on broker");
		expect(brokerStore!.listAuthCredentials(provider)).toHaveLength(1);
		expect(brokerStore!.getOAuth(provider)?.refresh).toBe("refresh-broker-newer");
	});
});
