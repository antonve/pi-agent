# TypeScript conventions for the managed Pi setup

- Target Pi 0.83 extension and TUI APIs.
- Run check, formatting, linting when available, and tests before finishing.
- Avoid unnecessary explicit return types; prefer inference and narrowing.
- Use `as any` only as an absolute last resort. Prefer real exported types, schemas, and type guards.
- Use `StringEnum` from `@earendil-works/pi-ai` for model-facing string enums.
- Propagate cancellation signals through model calls, process execution, polling, and waits.
- Bound process timeouts and truncate every model-facing tool result to 50 KB / 2,000 lines or less; spill full output privately when useful.
- Use existing Pi TUI components before creating custom components. Every rendered line must fit its width.
- Use Effect where it improves concurrency, cancellation, retries, scoped cleanup, process execution, typed failures, polling, and injected services. Plain TypeScript is preferred for small synchronous transformations and thin registrations.
- Inject or mock Herdr, Treehouse, process, filesystem, and clock services in tests. Fake CLIs are preferred over changing the live session.
- Never edit Herdr-generated integration files.
- Preserve exact built-in result and `details` shapes when overriding built-in tools.
- Keep all runtime dependencies centralized in the root `package.json`; do not add nested package installs.
