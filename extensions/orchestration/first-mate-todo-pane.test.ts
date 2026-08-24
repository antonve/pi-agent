import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CliRunner } from "./cli.ts";
import { HerdrClient } from "./herdr-client.ts";
import { FirstMateTodoPaneController } from "./first-mate-todo-pane.ts";
import { TodoPaneRuntimeStore } from "./first-mate-todo-state.ts";

function layout(panes: Array<{ pane_id: string; x: number; width: number }>) {
  return JSON.stringify({
    result: {
      layout: {
        workspace_id: "w1",
        tab_id: "w1:t1",
        panes: panes.map((pane) => ({
          pane_id: pane.pane_id,
          focused: pane.pane_id === "w1:p1",
          rect: { x: pane.x, y: 0, width: pane.width, height: 20 },
        })),
      },
    },
  });
}

async function runtimeStore() {
  const directory = await mkdtemp(join(tmpdir(), "pi-first-mate-todo-pane-"));
  return new TodoPaneRuntimeStore(join(directory, "runtime.json"));
}

test("controller creates a narrow right-hand pane without stealing focus", async () => {
  const calls: string[][] = [];
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([{ pane_id: "w1:p1", x: 0, width: 100 }]),
        };
      if (args[0] === "pane" && args[1] === "split")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }),
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: "w1:p2",
                foreground_processes: [{ cmdline: "bash" }],
              },
            },
          }),
        };
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(runner),
    await runtimeStore(),
  );

  const result = await controller.ensure({
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  });

  assert.deepEqual(result, { paneId: "w1:p2", created: true, restarted: true });
  assert.ok(
    calls.some(
      (args) =>
        args.join(" ").includes("pane split --pane w1:p1") &&
        args.includes("--direction") &&
        args.includes("right") &&
        args.includes("--ratio") &&
        args.includes("0.22") &&
        args.includes("--no-focus"),
    ),
  );
  assert.ok(
    calls.some(
      (args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p2",
    ),
  );
  assert.equal(
    calls.some((args) => args[0] === "tab" && args[1] === "focus"),
    false,
  );
});

test("controller reuses an existing running board pane", async () => {
  const calls: string[][] = [];
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p1", x: 0, width: 80 },
            { pane_id: "w1:p2", x: 80, width: 20 },
          ]),
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: "w1:p2",
                foreground_processes: [
                  {
                    cmdline:
                      "node --experimental-strip-types first-mate-todo-pane-cli.ts",
                  },
                ],
              },
            },
          }),
        };
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(runner),
    await runtimeStore(),
  );

  const result = await controller.ensure({
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  });

  assert.deepEqual(result, {
    paneId: "w1:p2",
    created: false,
    restarted: false,
  });
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "split"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "run"),
    false,
  );
});

test("controller reclaims a board on the same workspace without duplicates", async () => {
  const calls: string[][] = [];
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "w1:p1",
    tabId: "w1:t2",
    workspaceId: "w1",
    startedAt: 1,
  });
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([{ pane_id: "w1:p1", x: 0, width: 100 }]),
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: args.at(-1),
                foreground_processes: [
                  {
                    cmdline:
                      args.at(-1) === "w1:p2"
                        ? "node first-mate-todo-pane-cli.ts"
                        : "bash",
                  },
                ],
              },
            },
          }),
        };
      if (args[0] === "pane" && args[1] === "split")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }),
        };
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(runner),
    runtime,
  );

  const result = await controller.ensure({
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  });

  assert.deepEqual(result, { paneId: "w1:p3", created: true, restarted: true });
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "pane" && args[1] === "close" && args[2] === "w1:p2",
    ),
  );
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "split").length,
    1,
  );
});

test("controller reuses and moves a discovered board to the far right", async () => {
  const calls: string[][] = [];
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p2", x: 0, width: 30 },
            { pane_id: "w1:p1", x: 30, width: 40 },
            { pane_id: "w1:p3", x: 70, width: 30 },
          ]),
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: args.at(-1),
                foreground_processes: [
                  {
                    cmdline:
                      args.at(-1) === "w1:p2"
                        ? "node first-mate-todo-pane-cli.ts"
                        : "bash",
                  },
                ],
              },
            },
          }),
        };
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(runner),
    await runtimeStore(),
  );

  const result = await controller.ensure({
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  });

  assert.deepEqual(result, {
    paneId: "w1:p2",
    created: false,
    restarted: false,
  });
  assert.ok(
    calls.some(
      (args) =>
        args.join(" ") === "pane swap --source-pane w1:p2 --target-pane w1:p3",
    ),
  );
  assert.equal(
    calls.some(
      (args) =>
        (args[0] === "pane" && args[1] === "focus") ||
        (args[0] === "tab" && args[1] === "focus") ||
        (args[0] === "workspace" && args[1] === "focus"),
    ),
    false,
  );
});

test("controller restarts the pane after the board process exits", async () => {
  const calls: string[][] = [];
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
    startedAt: 1,
  });
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args.join(" ") === "pane get w1:p2")
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: "w1:p2",
                foreground_processes: [{ cmdline: "bash" }],
              },
            },
          }),
        };
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(runner),
    runtime,
  );

  const result = await controller.ensure({
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  });

  assert.deepEqual(result, {
    paneId: "w1:p2",
    created: false,
    restarted: true,
  });
  assert.ok(
    calls.some(
      (args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p2",
    ),
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "split"),
    false,
  );
});
