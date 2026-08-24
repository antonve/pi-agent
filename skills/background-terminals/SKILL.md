---
name: background-terminals
description: Run and manage long-lived commands in visible Herdr tabs. Use for servers, watchers, long builds, and long test suites while continuing other work.
---

# Background terminals through Herdr

- Use `bg_start` for servers, watchers, long builds, and long tests. Use ordinary `bash` for quick commands.
- Managed commands always use tabs; do not create panes or raw Herdr resources.
- Declare `kind: finite` for commands expected to exit and `kind: service` for servers and watchers.
- Every service must declare `ready_pattern`; set `readiness_timeout_seconds` when the 60-second default is inappropriate. A match changes the service from starting to running; an unrequested exit is a failure.
- Set `timeout_seconds` whenever a finite owner-independent lifetime is known.
- Do not start duplicate servers or watchers.
- Continue useful work after starting a command; completion is delivered automatically.
- For polling commands that print repeated status snapshots, print `"$PI_BACKGROUND_SNAPSHOT"` on its own line immediately before each complete snapshot. Completion delivers only the final marked snapshot.
- Use `bg_status` or `/ps` to inspect output. `/ps` can list, focus, interrupt, pin, unpin, and close only tracked resources.
- Successful, failed, cancelled, interrupted, and timed-out tabs close after their durable result is delivered. Focusing postpones cleanup while inspecting; only explicit pinning retains a settled tab.
- Services remain only for their declared owner lifetime. A second mate must stop task-owned services before completing or failing its task.
