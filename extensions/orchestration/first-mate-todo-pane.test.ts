import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CliRunner } from "./cli.ts";
import { HerdrClient } from "./herdr-client.ts";
import {
  FirstMateTodoPaneController,
  TODO_RUNTIME_FINGERPRINT,
} from "./first-mate-todo-pane.ts";
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

function boardProcess(fingerprint = TODO_RUNTIME_FINGERPRINT) {
  return `node --experimental-strip-types first-mate-todo-pane-cli.ts --todo-runtime-fingerprint=${fingerprint}`;
}

async function runtimeStore() {
  const directory = await mkdtemp(join(tmpdir(), "pi-first-mate-todo-pane-"));
  return new TodoPaneRuntimeStore(join(directory, "runtime.json"));
}

class FocusTrackingHerdrClient extends HerdrClient {
  currentFocus: string | undefined;
  readonly focusCalls: string[] = [];

  constructor(runner: CliRunner, focusedPane: string) {
    super(runner);
    this.currentFocus = focusedPane;
  }

  override async focusedPaneId() {
    return this.currentFocus;
  }

  override async focusPane(paneId: string) {
    this.focusCalls.push(paneId);
    this.currentFocus = paneId;
  }
}

test("controller creates a 25% right-hand pane and restores the exact focused pane", async () => {
  const calls: string[][] = [];
  let created = false;
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: created
            ? layout([
                { pane_id: "w1:p1", x: 0, width: 75 },
                { pane_id: "w1:p2", x: 75, width: 25 },
              ])
            : layout([{ pane_id: "w1:p1", x: 0, width: 100 }]),
        };
      if (args[0] === "pane" && args[1] === "split") {
        created = true;
        herdr.currentFocus = "w1:p2";
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }),
        };
      }
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
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const controller = new FirstMateTodoPaneController(
    herdr,
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
        args.includes("0.75") &&
        args.includes("--no-focus"),
    ),
  );
  assert.ok(
    calls.some(
      (args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p2",
    ),
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "resize"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "tab" && args[1] === "focus"),
    false,
  );
  assert.equal(herdr.currentFocus, "w1:p1");
  assert.deepEqual(herdr.focusCalls, ["w1:p1"]);
});

test("controller idempotently reuses an existing running board pane", async () => {
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
                foreground_processes: [{ cmdline: boardProcess() }],
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

  const location = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  };
  const first = await controller.ensure(location);
  const second = await controller.ensure(location);

  assert.deepEqual(first, {
    paneId: "w1:p2",
    created: false,
    restarted: false,
  });
  assert.deepEqual(second, first);
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "split"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "resize"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "run"),
    false,
  );
});

test("controller restarts an owned board when its runtime fingerprint changes", async () => {
  const calls: string[][] = [];
  let stopped = false;
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
    startedAt: 1,
    fingerprint: "older-source",
  });
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "get")
        return { code: 0, stderr: "", stdout: "{}" };
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
                  { cmdline: stopped ? "bash" : boardProcess("older-source") },
                ],
              },
            },
          }),
        };
      if (args[0] === "pane" && args[1] === "send-keys") stopped = true;
      return { code: 0, stderr: "", stdout: "{}" };
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
  assert.equal(
    calls.filter(
      (args) =>
        args[0] === "pane" &&
        args[1] === "send-keys" &&
        args.includes("ctrl+c"),
    ).length,
    1,
  );
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "run").length,
    1,
  );
  assert.equal((await runtime.read()).paneId, "w1:p2");
  assert.equal((await runtime.read()).fingerprint, TODO_RUNTIME_FINGERPRINT);
});

test("controller surfaces an owned board restart failure and restores focus", async () => {
  const calls: string[][] = [];
  let stopped = false;
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
                  { cmdline: stopped ? "bash" : boardProcess("older-source") },
                ],
              },
            },
          }),
        };
      if (args[0] === "pane" && args[1] === "send-keys") stopped = true;
      if (args[0] === "pane" && args[1] === "run")
        return { code: 1, stderr: "restart failed", stdout: "" };
      return { code: 0, stderr: "", stdout: "{}" };
    },
  };
  const herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const controller = new FirstMateTodoPaneController(
    herdr,
    await runtimeStore(),
  );

  await assert.rejects(
    controller.ensure({
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      cwd: "/repo",
    }),
    /restart failed/,
  );
  assert.equal(herdr.currentFocus, "w1:p1");
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "close").length,
    0,
  );
});

test("controller never kills or replaces an unrelated process in a stale runtime pane", async () => {
  const calls: string[][] = [];
  let created = false;
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
    startedAt: 1,
    fingerprint: "older-source",
  });
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "get")
        return { code: 0, stderr: "", stdout: "{}" };
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: created
            ? layout([
                { pane_id: "w1:p1", x: 0, width: 78 },
                { pane_id: "w1:p2", x: 78, width: 11 },
                { pane_id: "w1:p3", x: 89, width: 11 },
              ])
            : layout([
                { pane_id: "w1:p1", x: 0, width: 80 },
                { pane_id: "w1:p2", x: 80, width: 20 },
              ]),
        };
      if (args[0] === "pane" && args[1] === "process-info") {
        const paneId = String(args.at(-1));
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: paneId,
                foreground_processes: [
                  {
                    cmdline: paneId === "w1:p2" ? "vim important.txt" : "bash",
                  },
                ],
              },
            },
          }),
        };
      }
      if (args[0] === "pane" && args[1] === "split") {
        created = true;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }),
        };
      }
      return { code: 0, stderr: "", stdout: "{}" };
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
    paneId: "w1:p3",
    created: true,
    restarted: true,
  });
  assert.equal(
    calls.some(
      (args) =>
        (args[0] === "pane" && args[1] === "send-keys") ||
        (args[0] === "pane" && args[1] === "close" && args[2] === "w1:p2"),
    ),
    false,
  );
});

test("controller preserves manual widening and narrowing across reconciliation", async () => {
  const calls: string[][] = [];
  let boardWidth = 60;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p1", x: 0, width: 100 - boardWidth },
            { pane_id: "w1:p2", x: 100 - boardWidth, width: boardWidth },
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
                foreground_processes: [{ cmdline: boardProcess() }],
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
  const location = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  const widened = await controller.ensure(location);
  assert.equal(boardWidth, 60);
  boardWidth = 10;
  const narrowed = await controller.ensure(location);

  assert.deepEqual(widened, {
    paneId: "w1:p2",
    created: false,
    restarted: false,
  });
  assert.deepEqual(narrowed, widened);
  assert.equal(boardWidth, 10);
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "resize"),
    false,
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

test("controller reclaims a board on the same workspace without duplicates", async () => {
  const calls: string[][] = [];
  let created = false;
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
          stdout: created
            ? layout([
                { pane_id: "w1:p1", x: 0, width: 78 },
                { pane_id: "w1:p3", x: 78, width: 22 },
              ])
            : layout([{ pane_id: "w1:p1", x: 0, width: 100 }]),
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
                    cmdline: args.at(-1) === "w1:p2" ? boardProcess() : "bash",
                  },
                ],
              },
            },
          }),
        };
      if (args[0] === "pane" && args[1] === "split") {
        created = true;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }),
        };
      }
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
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "pane" &&
        args[1] === "split" &&
        args.includes("--ratio") &&
        args.includes("0.75"),
    ),
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
            { pane_id: "w1:p2", x: 0, width: 20 },
            { pane_id: "w1:p1", x: 20, width: 60 },
            { pane_id: "w1:p3", x: 80, width: 20 },
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
                    cmdline: args.at(-1) === "w1:p2" ? boardProcess() : "bash",
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
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p1", x: 0, width: 78 },
            { pane_id: "w1:p2", x: 78, width: 22 },
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

test("repeated task-assignment-like reconciliation restores the exact first-mate pane", async () => {
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p1", x: 0, width: 80 },
            { pane_id: "w1:p2", x: 80, width: 20 },
          ]),
        };
      if (args[0] === "pane" && args[1] === "process-info") {
        herdr.currentFocus = "w1:p2";
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: "w1:p2",
                foreground_processes: [{ cmdline: boardProcess() }],
              },
            },
          }),
        };
      }
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const controller = new FirstMateTodoPaneController(
    herdr,
    await runtimeStore(),
  );
  const location = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  for (let reconciliation = 0; reconciliation < 3; reconciliation++) {
    await controller.ensure(location);
    assert.equal(herdr.currentFocus, "w1:p1");
  }
  assert.deepEqual(herdr.focusCalls, ["w1:p1", "w1:p1", "w1:p1"]);
});

test("reload restart preserves manual width and restores intentional focus", async () => {
  const calls: string[][] = [];
  const boardWidth = 50;
  let stopped = false;
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p1", x: 0, width: 100 - boardWidth },
            { pane_id: "w1:p2", x: 100 - boardWidth, width: boardWidth },
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
                  { cmdline: stopped ? "bash" : boardProcess("older-source") },
                ],
              },
            },
          }),
        };
      if (args[0] === "pane" && args[1] === "send-keys") stopped = true;
      if (args[0] === "pane" && args[1] === "run") herdr.currentFocus = "w1:p1";
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p2");
  const controller = new FirstMateTodoPaneController(
    herdr,
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
    restarted: true,
  });
  assert.equal(boardWidth, 50);
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "resize"),
    false,
  );
  assert.equal(herdr.currentFocus, "w1:p2");
  assert.deepEqual(herdr.focusCalls, ["w1:p2"]);
});
