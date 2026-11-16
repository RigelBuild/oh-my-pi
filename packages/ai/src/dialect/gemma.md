## Format guide

Emit each tool call as one `<|tool_call>` block. The body is `call:NAME{key:value,...}`; wrap every string value in the `<|"|>` token:

```text
<|tool_call>call:function_name{path:<|"|>src/a.ts<|"|>,count:2}<tool_call|>
```

Non-string values are bare: numbers (`2`), `true`/`false`, `null`, lists `[<|"|>a<|"|>,<|"|>b<|"|>]`, and nested objects `{k:<|"|>v<|"|>}`.

Tool results arrive later in matching `<|tool_response>` blocks:

```text
<|tool_response>response:function_name{output:<|"|>verbatim result<|"|>}<tool_response|>
```

## Rules

- `NAME` MUST match a listed function; arguments are `key:value` pairs separated by commas.
- String values between `<|"|>` tokens are raw literal text (no escaping); never HTML-escape them — write `a & b`, not `a &amp; b`.
- Multiple calls = consecutive `<|tool_call>...<tool_call|>` blocks; keep prose outside them.
- The closer is `<tool_call|>` (pipe on the right), not `</tool_call>` or `<|tool_call>`.
- NEVER emit tool calls inside a `<|channel>thought…<channel|>` block; they are not parsed.
- Read each `<|tool_response>` block in call order. NEVER write a `<|tool_response>` block yourself.
- Write each call in full, THEN stop and halt — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no `<|tool_call>` block emitted).
