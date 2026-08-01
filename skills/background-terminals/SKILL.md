---
name: background-terminals
description: Run and manage long-lived commands in visible Herdr tabs or panes. Use for servers, watchers, long builds, and long test suites while continuing other work.
---

# Background terminals through Herdr

- Use `bg_start` for servers, watchers, long builds, and long tests. Use ordinary `bash` for quick commands.
- Durable commands use Herdr tabs by default. Request a pane only for short, directly relevant side-by-side work.
- Do not start duplicate servers or watchers.
- Continue useful work after starting a command; completion is delivered automatically.
- Use `bg_status` or `/ps` to inspect output. `/ps` can list, focus, send text or validated keys, interrupt, and close only resources tracked by this setup.
- Successful task tabs close after 30 seconds. Focusing or interacting cancels pending cleanup. Failed tasks remain visible.
