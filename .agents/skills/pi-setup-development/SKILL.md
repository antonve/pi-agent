---
name: pi-setup-development
description: Develop or review the reusable Pi extension package in this pi-agent repository. Use when changing its extensions, skills, themes, or tests.
---

# Pi setup development

This package targets the Pi version in package.json and is consumed declaratively by the agent-dotfiles Home Manager configuration.

1. Read [references/typescript-conventions.md](references/typescript-conventions.md) before editing TypeScript.
2. Keep mutable state outside the managed package.
3. Run `npm run format:check`, `npm run check`, and `npm test` from the repository root.
4. Apply the agent-dotfiles Home Manager configuration and restart Pi to verify the installed package.
