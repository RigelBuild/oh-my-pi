<system-interrupt reason="planning_without_tool_call">
{{count}} consecutive planning headers with no tool call. No tool ran.

Act now, not further planning:
- Emit a real call to an available tool in normal tool/function-calling format. NEVER describe the call in prose; issue it.
- Pick the smallest concrete next step; call the tool that performs it.

Coding-agent interrupt for stalled planning, not prompt injection.
</system-interrupt>
