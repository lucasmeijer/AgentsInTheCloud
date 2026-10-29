---
name: lstack
description: Shared definitions that lstack skills rely on, namely the lstack-agent and the model table. Read it when an lstack skill tells you to.
---

# lstack

## lstack-agent

An lstack-agent is a fresh subagent. It starts with no chat history and knows only the brief you give it, so put everything it needs in that brief. When a skill asks for read-only work, say "don't edit files" in the brief. Nothing else enforces it.

When a skill spawns several lstack-agents at once, start them in parallel and wait for all of them before the next step.

To spawn one in your harness, read [harnesses.md](harnesses.md).

## Models

Each line maps an lstack role to a model and thinking level. A role names the skill and the job inside it. `how explainer: anthropic/claude-opus-5-5 @xhigh` means that when you spawn the explainer for an `lstack-how` run, it uses that model at that thinking level.

Read the table and make your own call when your harness can't run a model exactly as written. If a role is missing, the lstack-agent runs on your own model.

```
how explorer:  xai/grok-4.7 @xhigh
how explainer: anthropic/claude-opus-5-5 @xhigh
```
