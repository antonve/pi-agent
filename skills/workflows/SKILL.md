---
name: workflows
description: Build explicitly requested workflow or ultracode multi-agent orchestration using the inline JavaScript DSL and Herdr-backed agents. Use only when the user explicitly requests a workflow, ultracode, or workflow orchestration.
---

# Herdr workflows

The `workflow` tool accepts an inline JavaScript program. It is available only after explicit workflow/ultracode intent.

```js
export const meta = { name: "implement-and-review", phases: [{ title: "implement" }, { title: "review" }] };
phase("implement");
const implementation = await agent("Implement the narrowly scoped change", {
  label: "implement", role: "implementation", harness: "codex", model: "gpt-5.6-sol", effort: "high", isolation: "treehouse"
});
if (!implementation.ok) return implementation;
phase("review");
return await parallel([
  () => agent("Review only the requested change", {
    label: "fable-review", role: "review", reviewTargetModel: "openai-codex/gpt-5.6-sol",
    harness: "claude", model: "claude-fable-5", effort: "high", isolation: "shared"
  }),
  () => agent("Secondary review only for reliability-critical findings", {
    label: "grok-review", role: "review", reviewTargetModel: "openai-codex/gpt-5.6-sol",
    harness: "pi", model: "openrouter/x-ai/grok-4.6", effort: "high", isolation: "shared"
  })
]);
```

- `agent(prompt, { label, phase, role, reviewTargetModel, harness, model, provider, effort, isolation, sharedLease, schema })`
- `parallel([() => agent(...), ...], { concurrency })`, capped at four.
- Every child uses the centralized model-role policy. Invalid providers, harnesses, models, reasoning levels, and same-family reviews fail instead of falling back.
- Always check `ok` before consuming output. Use a schema when later phases branch on structured data.
- Each mutation-capable child gets a separate Treehouse lease unless explicit shared-lease collaboration is requested.
- Structured children must end with one JSON object. One correction prompt is sent if validation fails; a second invalid result fails explicitly.
- Background workflows use visible Herdr tabs. All children remain manageable through `/subagents` and `/workflows`.
