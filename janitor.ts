import { nodeCliRunner } from "./extensions/orchestration/cli.ts";
import {
  AUTO_CLOSE_MS,
  CLOSED_RECORD_RETENTION_MS,
  isAutoCloseStatus,
} from "./extensions/orchestration/domain.ts";
import {
  FIRST_MATE_HEARTBEAT_STALE_MS,
  FIRST_MATE_RECLAIM_GRACE_MS,
} from "./extensions/orchestration/fleet-manager.ts";
import { FleetStore } from "./extensions/orchestration/fleet.ts";
import { HerdrClient } from "./extensions/orchestration/herdr-client.ts";
import { TaskRegistry } from "./extensions/orchestration/registry.ts";
import { TreehouseClient } from "./extensions/orchestration/treehouse-client.ts";

const registry = new TaskRegistry();
const herdr = new HerdrClient(nodeCliRunner);
const treehouse = new TreehouseClient(nodeCliRunner);
const now = Date.now();

for (const task of await registry.list()) {
  if (task.resourceClosedAt !== undefined) continue;
  const parentExists = await herdr
    .paneExists(task.parentPaneId)
    .catch(() => true);
  const autoCloseAt =
    task.autoCloseAt ?? (task.settledAt ?? task.updatedAt) + AUTO_CLOSE_MS;
  const autoCloseDue =
    task.pinned !== true &&
    isAutoCloseStatus(task.status) &&
    autoCloseAt <= now;
  if (parentExists && !autoCloseDue) continue;
  if (parentExists && autoCloseDue && task.createdTab && task.tabId) {
    const focused = await herdr.tabIsFocused(task.tabId).catch(() => false);
    if (focused) {
      await registry.update(task.id, { autoCloseAt: now + AUTO_CLOSE_MS });
      continue;
    }
  }

  try {
    await herdr.closeResource(task);
  } catch {
    continue;
  }

  let lease = task.lease;
  if (lease?.returnState === "held") lease = await treehouse.returnLease(lease);
  const wasActive = task.status === "running" || task.status === "starting";
  await registry.update(task.id, {
    resourceClosedAt: now,
    autoCloseCancelled: false,
    ...(lease ? { lease } : {}),
    ...(wasActive
      ? {
          status: "interrupted",
          settledAt: now,
          error:
            "Owning parent Herdr pane no longer exists; the tracked child was closed by the janitor.",
        }
      : {}),
  });
}

await registry.pruneClosedBefore(now - CLOSED_RECORD_RETENTION_MS);

async function interruptTaskResources(taskId: string, reason: string) {
  const resources = (await registry.list()).filter(
    (resource) =>
      resource.ownerTaskId === taskId &&
      resource.resourceClosedAt === undefined,
  );
  for (const resource of resources) {
    try {
      await herdr.closeResource(resource);
    } catch {
      continue;
    }
    let lease = resource.lease;
    if (lease?.returnState === "held")
      lease = await treehouse.returnLease(lease);
    await registry.update(resource.id, {
      resourceClosedAt: now,
      autoCloseCancelled: false,
      ...(lease ? { lease } : {}),
      ...(resource.status === "running" || resource.status === "starting"
        ? { status: "interrupted", settledAt: now, error: reason }
        : {}),
    });
  }
}

async function managedAgentExists(paneId: string) {
  const paneExists = await herdr.paneExists(paneId).catch(() => true);
  if (!paneExists) return false;
  return herdr.agentExists(paneId).catch(() => true);
}

const fleet = new FleetStore();
let firstMate = await fleet.getFirstMate();
let firstMateGoneBeyondGrace = false;
if (firstMate) {
  const heartbeatFresh =
    now - firstMate.updatedAt < FIRST_MATE_HEARTBEAT_STALE_MS;
  const alive = heartbeatFresh || (await managedAgentExists(firstMate.paneId));
  if (alive) {
    firstMate = await fleet.clearFirstMateLost(firstMate.sessionId, now);
  } else {
    firstMate = await fleet.markFirstMateLost(firstMate.sessionId, now);
    firstMateGoneBeyondGrace =
      firstMate?.lostAt !== undefined &&
      now - firstMate.lostAt >= FIRST_MATE_RECLAIM_GRACE_MS;
  }
}

for (const original of await fleet.listTasks()) {
  let task = original;
  const terminal =
    task.state === "completed" ||
    task.state === "failed" ||
    task.state === "cancelled";
  if (!terminal) {
    const ownerGone =
      firstMate?.sessionId === task.ownerSessionId
        ? firstMateGoneBeyondGrace
        : task.ownerPaneId
          ? !(await managedAgentExists(task.ownerPaneId))
          : false;
    const mateGone = task.matePaneId
      ? !(await managedAgentExists(task.matePaneId))
      : false;
    if (ownerGone || mateGone) {
      const reason = `${[
        ownerGone ? "first-mate owner" : undefined,
        mateGone ? "second mate" : undefined,
      ]
        .filter(Boolean)
        .join(" and ")} Herdr pane disappeared.`;
      const type = mateGone ? "TASK_FAILED" : "CANCEL";
      await fleet.enqueue({
        taskId: task.id,
        type,
        fromSessionId: "pi-first-mate-janitor",
        ...(mateGone
          ? { toSessionId: task.ownerSessionId }
          : { toSessionId: task.mateSessionId, toTaskMate: true }),
        payload: { reason },
      });
      task = await fleet.updateTask(task.id, {
        state: "failed",
        error: reason,
        failureReason: "pane-disappeared",
        cleanupAt: now + AUTO_CLOSE_MS,
      });
      await interruptTaskResources(task.id, reason);
    }
  }

  if (
    task.pinned === true ||
    !task.workspaceId ||
    task.workspaceClosedAt !== undefined ||
    task.cleanupAt === undefined ||
    task.cleanupAt > now ||
    (task.state !== "completed" &&
      task.state !== "failed" &&
      task.state !== "cancelled")
  )
    continue;

  const messages = await fleet.messagesForTask(task.id);
  const terminalMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.type === "TASK_COMPLETED" ||
        message.type === "TASK_FAILED" ||
        message.type === "CANCEL",
    );
  const acknowledged = terminalMessage?.acknowledgedAt !== undefined;
  const forceCloseDue = now - task.cleanupAt >= 5 * 60_000;
  if (!acknowledged && !forceCloseDue) continue;
  const focused = await herdr
    .workspaceIsFocused(task.workspaceId)
    .catch(() => false);
  if (focused) {
    await fleet.updateTask(task.id, { cleanupAt: now + AUTO_CLOSE_MS });
    continue;
  }

  try {
    await herdr.closeWorkspace(task.workspaceId);
  } catch {
    continue;
  }
  await fleet.updateTask(task.id, { workspaceClosedAt: now });
}
