---
name: subagents
description: Delegate self-contained work to headless Pi, Claude Code, Codex, or OpenCode leaf workers shown in Herdr tabs.
---

# Headless leaf workers through Herdr

All leaf lifecycle, prompts, follow-ups, output, cancellation, and cleanup go through the orchestration tools. Leaves cannot recursively call subagent, workflow, first-mate, or Herdr-control tools.

- Choose `pi`, `claude`, `codex`, or `opencode` deliberately.
- Pi inherits the parent model/reasoning by default. Grok runs through Pi with high reasoning; never silently route Grok through OpenCode.
- Claude defaults to latest Fable at high reasoning. Codex defaults to `gpt-5.6-sol` at high reasoning. OpenCode uses its configured default unless overridden.
- Give a complete standalone prompt with paths, constraints, and expected structured output.
- Mutation-capable tasks use `isolation: auto` or `treehouse`; read-only review may use `shared`. When uncertain, isolate.
- Every leaf gets a tab in its owning task workspace. The harness runs headlessly with the initial prompt supplied during process startup; never create an empty interactive TUI or simulate Enter.
- A successful spawn means structured process activity was observed. Startup without activity is bounded and fails instead of leaving an empty worker.
- A question is a settled headless turn. Answer it with `subagent_send`, which resumes the same harness session in the same tab.
- Continue parent work after spawning. Use `subagent_wait` only when blocked; it ends the current parent turn and resumes with one combined result.
- `/subagents` and subagent tools inspect, focus, prompt, interrupt, pin, unpin, close, and report lease cleanup state.
- Completed and failed leaves persist their report and close after the grace period. Focusing postpones cleanup; explicit pinning retains a tab.
