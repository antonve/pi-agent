# Managed Pi setup

This Pi package is consumed by the `agent-dotfiles` Home Manager configuration. It includes the upstream-inspired dashboard, ask-user, copy-all, system `fd`/`rg`, Git/model state, and Herdr/Treehouse orchestration. The run recap extension remains available for explicit opt-in use. Firecrawl is intentionally excluded.

## Operations

- `/clear` — start a new session; alias for `/new`.
- `/pull` — run `git pull` in the repository's main worktree.
- `/ps` — list and interact with tracked background commands.
- `/subagents` — list, inspect, focus, prompt, interrupt, close, or attach to children.
- `/workflows` — list workflow run artifacts.
- To opt into run recaps, load `./extensions/summaries/index.ts` explicitly; `/summary-model` confirms the fixed approved direct Luna/high route under `~/.config/pi-herdr`.
- `/firstmate status` inspects the machine-wide singleton first mate; `/firstmate claim` explicitly claims it or reclaims it from a dead owner.
- Claimed first-mate turns stay supervisory: new repo-changing work must be delegated with `task_assign` before direct investigation or edits.
- `first_mate_claim` and `first_mate_status` expose the same lifecycle to the model.
- Claimed first-mate sessions keep a dedicated narrow `firstmate-todo` pane on the far right of the claimed tab. It survives reload/reclaim, recreates itself if the pane or TUI process disappears, and never steals focus during provisioning or recovery.
- The to-do pane combines generated actions with manual items. Controls: `j/k` or arrows move, `enter` runs the primary focus/open action, `f` focuses the task workspace, `o` opens a tracked PR, `d` marks done, `x` dismisses, `z` snoozes, `a` adds, `e` edits manual items, `r` refreshes, and `?` shows help.
- First-mate tools create one Herdr Space per task, with a persistent Pi second mate in the first tab and active headless leaves in later tabs.
- `task_assign`, `task_list`, `task_send`, and `task_cancel` manage the durable task portfolio after the role is claimed.
- `task_assign` and `mate_register` accept `linear_issue`; linked second mates then read the issue before planning, keep one managed living-plan comment updated, move the issue to started when work begins, and complete it only after verified success.
- `mate_register`, `raise_decision`, `complete_task`, and `fail_task` support task-scoped second mates, including independently opened Pi sessions.
- Linear tools cover routine issue search/read/create/update/comment workflows, with unrestricted GraphQL as a fallback. Set `LINEAR_API_KEY` in `~/.config/agentbox/secrets.env`.
- `github-dark-default` and warm yellow-orange `gruvbox-dark` themes are included.
- State, results, workflow artifacts, and lease ownership live under `~/.local/state/pi-herdr`.
- The to-do pane persists manual items, done/snooze/dismiss state, PR snapshots, and pane runtime data under `~/.local/state/pi-herdr/first-mate-todo`. Only tracked GitHub PR URLs are polled, and cached PR state remains visible when GitHub is unavailable.
- `systemctl --user status pi-herdr-janitor.timer` — inspect durable cleanup.
- `journalctl --user -u pi-herdr-janitor.service` — inspect cleanup errors.

## Orchestration model policy

First mates default to direct `openai-codex/gpt-5.6-sol` at medium reasoning. Persistent second mates are fixed to that direct model at high. Implementation leaves may use direct Sol at high/xhigh/max, Grok 4.6 through Pi at high, or exact `claude-fable-5` through Claude Code at high/xhigh/max. Data-processing leaves use direct Luna at high/xhigh or DeepSeek V4 Flash through Pi at high. Summaries and compiled reports are fixed to direct `openai-codex/gpt-5.6-luna` at high.

Review leaves declare `role: "review"` and `review_target_model`; the reviewer must be from a different family. Primary review defaults across Sol and Fable. Reliability-critical work adds Grok 4.6 as a secondary review so Sol, Fable, and Grok all participate. Fable never routes through OpenRouter, GPT-5.6 never routes through OpenRouter, and unapproved models, harnesses, providers, or reasoning levels fail explicitly.

Completed, failed, cancelled, interrupted, and timed-out resources close automatically after 30 seconds; focusing or interacting with one postpones cleanup by another 30 seconds. Only explicit pinning retains a settled resource. Blocked leaf turns stay available for a headless resume. Captured output remains on disk after terminal cleanup, and closed registry records are pruned after seven days. Guarded Treehouse return never uses `--force`; dirty leases remain visible in the registry and `treehouse status`. The first-mate to-do pane is not a tracked worker resource and stays independent of task-workspace auto-close.

Leaf workers use process-per-turn headless Pi, Claude Code, Codex, or OpenCode invocations. A no-shell wrapper supplies prompts through stdin or process arguments at startup, structured activity acknowledges delivery, and follow-ups resume the same harness session. Leaves cannot launch nested agents or control Herdr/Treehouse resources. Herdr hosts visible task tabs but does not type prompts or simulate Enter for leaves.

Fleet state, singleton first-mate ownership, and acknowledged control messages live under `~/.local/state/pi-herdr/fleet.json`. The extension deterministically checks this inbox without model polling and wakes sessions only for decisions, material risks, failures, cancellations, and final outcomes. A replacement Pi session can reclaim a dead first mate, atomically adopting its tasks and pending outcomes; a live owner cannot be displaced. The janitor allows a five-minute reclaim window before treating first-mate loss as terminal and reconciles task workspaces after their outcome is acknowledged.

## Calm tool output

Pi's normal collapsed view hides successful `read` and `bg_status` rows and reduces `bash`, `edit`, `write`, `bg_start`, `bg_list`, and `bg_kill` to their call line. Failures remain visible. Press Ctrl+O to reveal full calls and results; Pi's existing Working presentation is unchanged.

## Development

```sh
cd ~/xdev/personal/pi-agent
npm ci --legacy-peer-deps
npm run format
npm run check
npm test
```

Then evaluate/apply Home Manager and use Pi's `/reload`. Never edit `~/.pi/agent/extensions/herdr-agent-state.ts`; it is generated by Herdr and deliberately unmanaged here.
