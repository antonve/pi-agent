---
name: pi-setup-development
description: Develop or review the reusable Pi extension package in this pi-agent repository. Use when changing its Pi extensions, skills, theme, orchestration, janitor, or tests.
---

# Pi setup development

This package targets Pi 0.83 and is consumed declaratively by the agent-dotfiles Home Manager configuration.

1. Read [references/typescript-conventions.md](references/typescript-conventions.md) before editing TypeScript.
2. Never edit Herdr-generated integration files, especially `~/.pi/agent/extensions/herdr-agent-state.ts`.
3. Keep mutable state under `~/.local/state/pi-herdr` or `~/.config/pi-herdr`, never under the managed package.
4. Run `npm run format:check`, `npm run check`, and `npm test` from the repository root.
5. After publishing package changes, update and evaluate the `piAgent` input in agent-dotfiles.
