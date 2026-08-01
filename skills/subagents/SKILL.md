---
name: subagents
description: Delegate work to subagents or multiple agents and coordinate cross-agent work through visible Herdr tabs/panes. Use for delegation, subagents, multiple-agent tasks, cross-agent communication, or explicit Herdr requests.
---

# Herdr subagents

All child lifecycle, prompts, communication, inspection, and takeover go through Herdr. Children cannot recursively call subagent or workflow tools.

- Choose `pi`, `claude`, `codex`, or `opencode` deliberately.
- Pi inherits the parent model/reasoning by default. Grok runs through Pi with high reasoning; never silently route Grok through OpenCode.
- Claude defaults to latest Fable at high reasoning. Codex defaults to `gpt-5.6-sol` at high reasoning. OpenCode uses its configured default unless overridden.
- Give a complete standalone prompt with relevant paths, constraints, expected output, and Treehouse context.
- Mutation-capable tasks use `isolation: auto` or `treehouse`; read-only review may use `shared`. When uncertain, isolate.
- Durable agents and Treehouse leases use tabs. Panes are only for brief, directly relevant work.
- Continue parent work after spawning. Wait only when blocked. Use `subagent_send` for follow-ups.
- `/subagents` and the subagent tools inspect, focus, attach/take over, cancel, and report lease cleanup state.
