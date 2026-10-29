# Spawning an lstack-agent

## AgentsInTheCloud builtin agent

Use codemode's `tools.agent`. Pass the role's model as `model` and its thinking level as `thinkingLevel`. Give a `schema` such as `{ type: "object", properties: { report: { type: "string" } }, required: ["report"] }` and ask for the full output in `report`. To run several in parallel, start them inside one `Promise.all` and return every result from the script, because only what the script returns reaches you.

Don't use `spawn_agent` for lstack-agents. It can't set a model.

## Claude Code

Use the `Agent` tool with `subagent_type: "general-purpose"`. Map the model to its family alias (`opus`, `sonnet`, `haiku`, or `fable`) and the thinking level to `effort`. If the role names a model from another provider, omit `model` so the agent runs on the session model, and say so in your reply. To run several in parallel, make all the `Agent` calls in one message.
