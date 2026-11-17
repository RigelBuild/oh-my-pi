{{#if subagent}}Results arrive only while this run is live; NEVER poll.{{#if waitTool}} Your run ends when you yield: call `wait` on pending jobs before you end your turn.{{/if}}{{else}}Results auto-deliver; NEVER poll.{{#if waitTool}} Completely blocked? Call `wait` to receive the first settled job you started.{{/if}}{{/if}}

`read proc://` lists jobs/services; `read proc://<id>` inspects status/output without consuming delivery. `write proc://<id>/kill` cancels/stops; omit `content`.

Job IDs are process-local; delivered results expire shortly (~30s), unconsumed results within ~5min. Agent output/transcripts remain readable at `agent://<id>` / `history://<id>`.{{#if ircEnabled}} `write agent://<id>` messages a live agent.{{/if}}

`completed`: subagent yielded successfully; claimed artifacts unverified.
