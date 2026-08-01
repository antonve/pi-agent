import { nodeCliRunner } from "./extensions/orchestration/cli.ts";
import { HerdrClient } from "./extensions/orchestration/herdr-client.ts";
import { TaskRegistry } from "./extensions/orchestration/registry.ts";
import { TreehouseClient } from "./extensions/orchestration/treehouse-client.ts";

const registry = new TaskRegistry();
const herdr = new HerdrClient(nodeCliRunner);
const treehouse = new TreehouseClient(nodeCliRunner);

for (const task of await registry.list()) {
  const parentExists = await herdr.paneExists(task.parentPaneId).catch(() => true);
  const autoCloseDue = task.status === "done" && !task.autoCloseCancelled && task.autoCloseAt !== undefined && task.autoCloseAt <= Date.now();
  if (!parentExists || autoCloseDue) {
    await herdr.closeResource(task).catch(() => undefined);
    if (task.lease?.returnState === "held") {
      const lease = await treehouse.returnLease(task.lease);
      await registry.update(task.id, { lease });
    }
    if (!parentExists && (task.status === "running" || task.status === "starting")) {
      await registry.update(task.id, { status: "interrupted", settledAt: Date.now(), error: "Owning parent Herdr pane no longer exists; tracked child was closed by the janitor." });
    }
  }
}
