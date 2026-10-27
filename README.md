# Managed Pi setup

This minimal Pi package is consumed by the `agent-dotfiles` Home Manager
configuration. It includes ask-user, copy-all, calm tool output, system `fd`/`rg`,
Git/model display, Linear tools, and themes. Draft provides planning and review.

## Shared skills

The machine's `agent-config` installation supplies personal skills, including
`draft-review`, through `~/.agents/skills/`, which Pi discovers automatically.
This package supplies only its Pi-specific skills. Consumers should install
the shared library before updating from a version that bundled
`draft-review-workflow`.

## Operations

- `/clear` starts a new session; alias for `/new`.
- `/pull` runs `git pull` in the repository's main worktree.
- Linear tools support issue search, reading, creation, updates, and comments,
  with GraphQL available when needed. Set `LINEAR_API_KEY` in the untracked
  `~/.config/agentbox/secrets.env`.
- `github-dark-default` and `gruvbox-dark` themes are included.

## Calm tool output

Pi's collapsed view hides successful `read` rows and reduces `bash`, `edit`, and
`write` to their call line. Failures remain visible. Press Ctrl+O to reveal full
calls and results; Pi's existing Working presentation is unchanged.

## Development

```sh
cd ~/xdev/personal/pi-agent
npm ci --legacy-peer-deps
npm run format
npm run check
npm test
```

Apply the corresponding Home Manager configuration and start a new Pi session
to load the installed extensions.
