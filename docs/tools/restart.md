# restart

> Cooperatively recycles this session to pick up host-staged changes a live `refresh` cannot reach (new extensions, project context, slash commands, prompt templates, the tool roster, the model/provider registry), continuing the same conversation from the durable session file.

## Source
- Entry: `packages/coding-agent/src/tools/restart.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/restart.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — `AgentSession.requestRestart()` / `#doRequestRestart(...)` orchestrate the recycle (quiesce the running turn, flush the transcript, dispose the session, then fire the host `onRestartRequested` callback), and `RequestRestartResult` is the returned outcome. The `#restarting` latch refuses new turns once a restart is committed.
  - `packages/coding-agent/src/tools/index.ts` — `RestartTool.createIf` is registered conditionally (returns `null` when `session.requestRestart` is unbound), so the tool is only offered when a host wired an `onRestartRequested` callback.
  - `packages/coding-agent/src/sdk.ts` — `CreateAgentSessionOptions.onRestartRequested` is the embedded-host re-attach hook; the SDK binds `requestRestart` on the released session only when that option is provided.

## Inputs

The tool takes no parameters (`restartSchema = type({})`).

## Outputs
Single-shot `AgentToolResult<RestartToolDetails>`.

- `content`: one text part. On a scheduled restart: `Restart scheduled. It runs once this turn settles; the conversation resumes in the recycled session.`
- `details`: `{ scheduled: boolean }` — `true` when the recycle was scheduled, `false` when it refused before teardown.

The acknowledgement returns immediately; the actual recycle runs from an untracked continuation after the current turn settles. A pre-teardown refusal (`requestRestart()` resolves `{ ok: false, reason }`) is surfaced back to the model via a `restart-refused` deferred message so it does not believe it restarted.

If the session exposes no `requestRestart` hook, `execute` returns `Restart is unavailable in this session.` as an error result (and `createIf` would normally have withheld the tool entirely).

## Flow
1. `RestartTool.execute(...)` reads `session.requestRestart`; if unbound it returns the unavailable error.
2. It fires `void requestRestart()` from an **untracked continuation** (a detached promise, never a tracked post-prompt task) and immediately returns the `{ scheduled: true }` acknowledgement. `requestRestart()`'s own `waitForIdle()` defers the recycle until the current turn settles, so returning the ack first does not race teardown.
3. `AgentSession.requestRestart()` coalesces concurrent calls (a second call while one is in flight returns the same promise) and applies the pre-latch refusals without latching or caching: `unavailable` (no host callback), `no-session-file` (in-memory session), `busy` (unpersisted input queued).
4. `#doRequestRestart(...)` runs the KEEP-sealed ordering: snapshot any in-flight refresh up front, `waitForIdle()`, re-check busy, capture the file-preserved session id, flush, `ensureOnDisk`, drain the snapshotted refresh, final busy re-check, `dispose()`, then `onRestartRequested({ sessionId, sessionFile })`.
5. The host re-opens the manager from the session file and recreates the session through the same configured options (create-before-dispose is unsafe, so the callback fires only after dispose).

## Modes / Variants
- Discoverable tool only; there is no `/restart` slash command surface. It is offered to the model when a host `onRestartRequested` callback is wired.

## Side Effects
- Filesystem
  - Flushes the transcript and `ensureOnDisk` before dispose, so the durable session file is current at the recycle point.
- Session state
  - Latches out new turns (`#restarting`) once committed, then disposes this session; the host recreates a fresh session from the file.
- User-visible prompts / interactive UI
  - A pre-teardown refusal surfaces a `restart-refused` deferred message so the model reacts to the refusal instead of assuming success.

## Limits & Caps
- Tool execution mode: `approval = "exec"`, `strict = true`, `loadMode = "discoverable"`.
- `approval = "exec"`: restart disposes and recycles the session (host-level re-attach), so `resolveApproval` prompts for it (exec tier outranks the `always-ask` / `write` mode caps) and it never auto-runs in those modes — only `yolo` (exec cap) auto-allows.
- Registration is conditional: `RestartTool.createIf` returns `null` when `session.requestRestart` is unbound, so a session with no host `onRestartRequested` callback is never shown a tool that would always error.

## Errors
- Session without a `requestRestart` hook: `execute` returns `Restart is unavailable in this session.` with `isError: true`.
- Pre-teardown refusals resolve `{ ok: false, reason }` with `reason` one of `unavailable` (no callback), `no-session-file` (no durable file to re-attach), `busy` (unpersisted input queued) — surfaced to the model; the session is left untouched and the call may be retried once quiet.

## Notes
- Restart recycles ONLY this session (same loaded engine code): it re-reads the session-start-frozen surfaces `refresh` does not (extensions, project context, slash commands, prompt templates, tool roster, model/provider registry). Picking up a new engine *binary* is a host-process operation, not this tool.
- Under an embedded host that re-attaches via `execvp` re-exec, `onRestartRequested` does not return in-process on success; the tool tolerates this because it returns the ack synchronously and the `{ ok: true }` continuation is a no-op path.
