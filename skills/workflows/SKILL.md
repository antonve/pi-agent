---
name: workflows
description: Build explicitly requested workflow or ultracode multi-agent orchestration using the inline JavaScript DSL and Herdr-backed agents. Use only when the user explicitly requests a workflow, ultracode, or workflow orchestration.
---

# Herdr workflows

The `workflow` tool accepts an inline JavaScript program. It is available only after explicit workflow/ultracode intent.

```js
export const meta = { name: "review-and-fix", phases: [{ title: "review" }, { title: "implement" }] };
phase("review");
const reviews = await parallel([
  () => agent("Review security", { label: "security", harness: "pi", isolation: "shared" }),
  () => agent("Review tests", { label: "tests", harness: "claude", isolation: "shared" })
]);
if (!reviews.every((result) => result.ok)) return reviews;
phase("implement");
return await agent(`Implement:\n${reviews.map((r) => r.output).join("\n")}`, {
  label: "implement", harness: "codex", model: "gpt-5.6-sol", effort: "high", isolation: "treehouse"
});
```

- `agent(prompt, { label, phase, harness, model, effort, isolation, sharedLease, schema })`
- `parallel([() => agent(...), ...], { concurrency })`, capped at four.
- Always check `ok` before consuming output. Use a schema when later phases branch on structured data.
- Each mutation-capable child gets a separate Treehouse lease unless explicit shared-lease collaboration is requested.
- Structured children must end with one JSON object. One correction prompt is sent if validation fails; a second invalid result fails explicitly.
- Background workflows use visible Herdr tabs. All children remain manageable through `/subagents` and `/workflows`.
