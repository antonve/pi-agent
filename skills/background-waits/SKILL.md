---
name: background-waits
description: Yield the parent Pi turn while registered asynchronous work such as subagents, CI checks, or deployments continues, then resume automatically with combined output.
---

# Background waits

Use `background_wait` only with task IDs returned by tools that explicitly say the task is registered for background waiting.

- Continue useful work before waiting. Call `background_wait` only when blocked on the registered results.
- Never invent IDs or pass process IDs, tool-call IDs, workflow-run IDs, URLs, or other identifiers unless the producing tool explicitly marks them as background-waitable task IDs.
- A successful `background_wait` call returns immediately and ends the current parent turn. The tasks continue through their owning extensions, so new user input can be processed meanwhile.
- After every requested task settles, one combined output message automatically starts a new model turn. If another turn is active, the result is queued as a follow-up.
- Use `subagent_wait` for subagents when its specialized name is clearer; it delegates to the same background-wait mechanism.
- CI and deployment tools can use this mechanism only after their extension registers the returned task ID. Do not fall back to polling with repeated tool calls unless the task provider requires it.

## Provider contract

Extension tools expose waitable work with `registerBackgroundWaitTask(pi, task)` from `extensions/shared/background-waits.ts`. A task supplies a stable `id`, concise `label`, `kind`, and `wait(signal)` function returning `{ status, output, successful?, details? }`.

- Register before returning the task ID to the model, and explicitly call that ID background-waitable in the tool result.
- Honor the supplied abort signal, bound the returned output, and keep durable provider state available for later inspection.
- Retain the unregister callback when task ownership ends before session shutdown.
