---
name: subagents
description: Delegate self-contained work to headless Pi, Claude Code, Codex, or OpenCode leaf workers shown in Herdr tabs.
---

# Headless leaf workers through Herdr

All leaf lifecycle, prompts, follow-ups, output, cancellation, and cleanup go through the orchestration tools. Leaves cannot recursively call subagent, workflow, first-mate, or Herdr-control tools.

- Set `role` deliberately: `implementation` (default), `data-processing`, or `review`.
- Implementation uses direct `openai-codex/gpt-5.6-sol` at high/xhigh/max (high preferred), `openrouter/x-ai/grok-4.6` through Pi at high, or exact `claude-fable-5` through Claude Code at high/xhigh/max.
- Data processing uses direct `openai-codex/gpt-5.6-luna` at high/xhigh or `openrouter/deepseek/deepseek-v4-flash-0731` through Pi at high.
- Fable never runs through Pi/OpenRouter, direct GPT-5.6 never runs through OpenRouter, and OpenCode has no approved orchestration route.
- Review workers require `review_target_model` and a different model family. Default primary review is Sol↔Fable; highly reliable work also gets a Grok 4.6 secondary review so all three families participate.
- Give a complete standalone prompt with paths, narrow scope, acceptance criteria, and expected structured output. Actively monitor leaves and redirect or cancel scope drift.
- Mutation-capable tasks use `isolation: auto` or `treehouse`; read-only review may use `shared`. When uncertain, isolate.
- Every leaf gets a tab in its owning task workspace. The harness runs headlessly with the initial prompt supplied during process startup; never create an empty interactive TUI or simulate Enter.
- A successful spawn means structured process activity was observed. Startup without activity is bounded and fails instead of leaving an empty worker.
- A question is a settled headless turn. Answer it with `subagent_send`, which resumes the same harness session in the same tab.
- Continue parent work after spawning. Use `subagent_wait` only when blocked; it ends the current parent turn and resumes with one combined result.
- `/subagents` and subagent tools inspect, focus, prompt, interrupt, pin, unpin, close, and report lease cleanup state.
- Completed and failed leaves persist their report and close after the grace period. Focusing postpones cleanup; explicit pinning retains a tab.
