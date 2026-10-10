import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bearerTokenAuthorizer, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { postmortem } from "@oh-my-pi/pi-utils";
import { registerGatewayShutdown } from "../../../src/cli/auth-gateway-cli";

const holdMs = Number(process.env.HOLD_MS);
const drainMs = Number(process.env.DRAIN_MS);

registerMockApi();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-shutdown-"));
const storage = await AuthStorage.create(path.join(dir, "auth.db"));
storage.keys.setRuntime("mock", "test-key");
const mock = createMockModel({
	handler: async () => {
		process.stdout.write("ACTIVE\n");
		await Bun.sleep(holdMs);
		return { content: ["held response completed"] };
	},
});
const handle = startAuthGateway({
	bind: "127.0.0.1:0",
	authorize: bearerTokenAuthorizer(["test-token"]),
	storage,
	resolveModel: () => mock.model,
});
postmortem.setCleanupDeadline(drainMs + 2_000);
registerGatewayShutdown(handle, drainMs, () => storage.close());
process.stdout.write(`URL ${handle.url} MODEL ${mock.model.id}\n`);
