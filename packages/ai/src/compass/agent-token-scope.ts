import { AsyncLocalStorage } from "node:async_hooks";

const agentTokenScope = new AsyncLocalStorage<string>();

export function runWithAgentToken<T>(token: string, run: () => T): T {
	return agentTokenScope.run(token, run);
}

export function currentAgentToken(): string | undefined {
	const token = agentTokenScope.getStore();
	return token ? token : undefined;
}
