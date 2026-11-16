## Format guide

A tool call wraps the function name, a separator, and one JSON object of arguments in fixed tokens. Emit them exactly:

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_name<｜tool▁sep｜>{"arg":"value"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

Results arrive as output tokens:

```text
<｜tool▁output▁begin｜>verbatim tool result<｜tool▁output▁end｜>
```

## Rules

- Use `｜` (U+FF5C) and `▁` (U+2581) exactly.
- Tool name MUST match an available function; arguments are one valid JSON object.
- Argument string values use only normal JSON string escaping (`\"`, `\\`, `\n`); never HTML-escape their contents — write `a & b`, not `a &amp; b`.
- NEVER wrap arguments in Markdown fences; NEVER emit a `type` field or `function` prefix.
- Multiple calls chain `<｜tool▁call▁begin｜>...<｜tool▁call▁end｜>` directly — no separators, spaces, or newlines between them.
- Read each output token in call order. NEVER emit output tokens yourself.
- Emit the stop sequence ONLY after the call is fully written — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no `<｜tool▁call▁begin｜>` emitted). Write the complete call, THEN the stop sequence, THEN halt.
