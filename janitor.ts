import { nodeCliRunner } from "./extensions/orchestration/cli.ts";
import {
  AUTO_CLOSE_MS,
  CLOSED_RECORD_RETENTION_MS,
  isAutoCloseStatus,
} from "./extensions/orchestration/domain.ts";
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
  const autoCloseDue = isAutoCloseStatus(task.status) && autoCloseAt <= now;
  if (parentExists && !autoCloseDue) continue;

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
