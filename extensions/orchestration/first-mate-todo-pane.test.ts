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

function assertApproximately(actual: number, expected: number) {
  const tolerance = 1e-9;
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
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

test("controller creates a 25% right-hand pane through no-focus APIs", async () => {
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
  assert.deepEqual(herdr.focusCalls, []);
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

test("controller restores a wider manual width through nested split geometry", async () => {
  const calls: string[][] = [];
  const nestedSplitWidth = 60;
  let boardAtRight = false;
  let boardWidth = 40;
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: boardAtRight
            ? layout([
                { pane_id: "w1:p3", x: 0, width: 40 },
                { pane_id: "w1:p1", x: 40, width: 60 - boardWidth },
                {
                  pane_id: "w1:p2",
                  x: 100 - boardWidth,
                  width: boardWidth,
                },
              ])
            : layout([
                { pane_id: "w1:p2", x: 0, width: 40 },
                { pane_id: "w1:p1", x: 40, width: 40 },
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
      if (args[0] === "pane" && args[1] === "swap") {
        boardAtRight = true;
        boardWidth = 20;
      }
      if (args[0] === "pane" && args[1] === "resize") {
        const amount = Number(args[args.indexOf("--amount") + 1]);
        const cells = Math.round(amount * nestedSplitWidth);
        boardWidth += args.includes("left") ? cells : -cells;
      }
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const runtime = await runtimeStore();
  const controller = new FirstMateTodoPaneController(herdr, runtime);

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
  assertApproximately(boardWidth, 40);
  assert.ok(
    calls.some(
      (args) =>
        args.join(" ") === "pane swap --source-pane w1:p2 --target-pane w1:p3",
    ),
  );
  const resizeCalls = calls.filter(
    (args) => args[0] === "pane" && args[1] === "resize",
  );
  assert.equal(resizeCalls.length, 2);
  assert.equal(
    resizeCalls[0]?.[resizeCalls[0].indexOf("--direction") + 1],
    "left",
  );
  assertApproximately(
    Number(resizeCalls[0]?.[resizeCalls[0].indexOf("--amount") + 1]),
    0.2,
  );
  assertApproximately(
    Number(resizeCalls[1]?.[resizeCalls[1].indexOf("--amount") + 1]),
    2 / 15,
  );
  assert.equal((await runtime.read()).paneId, "w1:p2");
  assert.equal(herdr.currentFocus, "w1:p1");
  assert.deepEqual(herdr.focusCalls, []);
});

test("post-swap layout failure keeps a wider board moved, saved, and exact focus", async () => {
  const calls: string[][] = [];
  let swapCompleted = false;
  let herdr!: FocusTrackingHerdrClient;
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "old-parent",
    tabId: "w1:t1",
    workspaceId: "w1",
    startedAt: 1,
    fingerprint: TODO_RUNTIME_FINGERPRINT,
  });
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "get")
        return { code: 0, stderr: "", stdout: "{}" };
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
      if (args[0] === "pane" && args[1] === "layout")
        return swapCompleted
          ? { code: 1, stderr: "injected layout failure", stdout: "" }
          : {
              code: 0,
              stderr: "",
              stdout: layout([
                { pane_id: "w1:p2", x: 0, width: 41 },
                { pane_id: "w1:p1", x: 41, width: 57 },
                { pane_id: "w1:p3", x: 98, width: 22 },
              ]),
            };
      if (args[0] === "pane" && args[1] === "swap") {
        swapCompleted = true;
      }
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const controller = new FirstMateTodoPaneController(herdr, runtime);

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
  assert.equal(swapCompleted, true);
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "swap").length,
    1,
  );
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "resize").length,
    0,
  );
  const saved = await runtime.read();
  assert.equal(saved.paneId, "w1:p2");
  assert.equal(saved.parentPaneId, "w1:p1");
  assert.equal(saved.fingerprint, TODO_RUNTIME_FINGERPRINT);
  assert.ok(saved.startedAt && saved.startedAt > 1);
  assert.equal(herdr.currentFocus, "w1:p1");
  assert.deepEqual(herdr.focusCalls, []);
});

test("post-swap resize failure keeps a narrower board moved, saved, and exact focus", async () => {
  let boardAtRight = false;
  let boardWidth = 11;
  let resizeArgs: string[] | undefined;
  let herdr!: FocusTrackingHerdrClient;
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "old-parent",
    tabId: "w1:t1",
    workspaceId: "w1",
    startedAt: 1,
    fingerprint: TODO_RUNTIME_FINGERPRINT,
  });
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "pane" && args[1] === "get")
        return { code: 0, stderr: "", stdout: "{}" };
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
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: boardAtRight
            ? layout([
                { pane_id: "w1:p3", x: 0, width: 11 },
                { pane_id: "w1:p1", x: 11, width: 71 },
                { pane_id: "w1:p2", x: 82, width: boardWidth },
              ])
            : layout([
                { pane_id: "w1:p2", x: 0, width: 11 },
                { pane_id: "w1:p1", x: 11, width: 71 },
                { pane_id: "w1:p3", x: 82, width: 38 },
              ]),
        };
      if (args[0] === "pane" && args[1] === "swap") {
        boardAtRight = true;
        boardWidth = 38;
      }
      if (args[0] === "pane" && args[1] === "resize") {
        resizeArgs = [...args];
        return { code: 1, stderr: "injected resize failure", stdout: "" };
      }
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const controller = new FirstMateTodoPaneController(herdr, runtime);

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
  assert.equal(boardAtRight, true);
  assertApproximately(boardWidth, 38);
  assert.ok(resizeArgs);
  assert.equal(resizeArgs[resizeArgs.indexOf("--direction") + 1], "right");
  assertApproximately(
    Number(resizeArgs[resizeArgs.indexOf("--amount") + 1]),
    27 / 120,
  );
  const saved = await runtime.read();
  assert.equal(saved.paneId, "w1:p2");
  assert.equal(saved.parentPaneId, "w1:p1");
  assert.equal(saved.fingerprint, TODO_RUNTIME_FINGERPRINT);
  assert.ok(saved.startedAt && saved.startedAt > 1);
  assert.equal(herdr.currentFocus, "w1:p1");
  assert.deepEqual(herdr.focusCalls, []);
});

test("repeated reconciliation restores a narrower manual width through nested split geometry", async () => {
  const calls: string[][] = [];
  const nestedSplitWidth = 90;
  let boardAtRight = false;
  let boardWidth = 10;
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: boardAtRight
            ? layout([
                { pane_id: "w1:p3", x: 0, width: 10 },
                { pane_id: "w1:p1", x: 10, width: 90 - boardWidth },
                {
                  pane_id: "w1:p2",
                  x: 100 - boardWidth,
                  width: boardWidth,
                },
              ])
            : layout([
                { pane_id: "w1:p2", x: 0, width: 10 },
                { pane_id: "w1:p1", x: 10, width: 55 },
                { pane_id: "w1:p3", x: 65, width: 35 },
              ]),
        };
      if (args[0] === "pane" && args[1] === "process-info") {
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
      }
      if (args[0] === "pane" && args[1] === "swap") {
        boardAtRight = true;
        boardWidth = 35;
      }
      if (args[0] === "pane" && args[1] === "resize") {
        const amount = Number(args[args.indexOf("--amount") + 1]);
        const cells = Math.round(amount * nestedSplitWidth);
        boardWidth += args.includes("left") ? cells : -cells;
      }
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const runtime = await runtimeStore();
  const controller = new FirstMateTodoPaneController(herdr, runtime);
  const location = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  for (let reconciliation = 0; reconciliation < 3; reconciliation++) {
    await controller.ensure(location);
    assertApproximately(boardWidth, 10);
    assert.equal(herdr.currentFocus, "w1:p1");
  }
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "swap").length,
    1,
  );
  const resizeCalls = calls.filter(
    (args) => args[0] === "pane" && args[1] === "resize",
  );
  assert.equal(resizeCalls.length, 2);
  assert.equal(
    resizeCalls[0]?.[resizeCalls[0].indexOf("--direction") + 1],
    "right",
  );
  assertApproximately(
    Number(resizeCalls[0]?.[resizeCalls[0].indexOf("--amount") + 1]),
    0.25,
  );
  assertApproximately(
    Number(resizeCalls[1]?.[resizeCalls[1].indexOf("--amount") + 1]),
    1 / 46,
  );
  assert.equal((await runtime.read()).paneId, "w1:p2");
  assert.deepEqual(herdr.focusCalls, []);
});

test("nested width feedback converges after a rounded no-progress step", async () => {
  const calls: string[][] = [];
  const nestedSplitWidth = 130;
  const targetWidth = 75;
  let nestedRatio = 1 - 15 / nestedSplitWidth;
  let boardAtRight = false;
  let boardWidth = targetWidth;
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: boardAtRight
            ? layout([
                { pane_id: "w1:p3", x: 0, width: targetWidth },
                {
                  pane_id: "w1:p1",
                  x: targetWidth,
                  width: 400 - targetWidth - boardWidth,
                },
                {
                  pane_id: "w1:p2",
                  x: 400 - boardWidth,
                  width: boardWidth,
                },
              ])
            : layout([
                { pane_id: "w1:p2", x: 0, width: targetWidth },
                { pane_id: "w1:p1", x: targetWidth, width: 310 },
                { pane_id: "w1:p3", x: 385, width: 15 },
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
      if (args[0] === "pane" && args[1] === "swap") {
        boardAtRight = true;
        boardWidth = 15;
      }
      if (args[0] === "pane" && args[1] === "resize") {
        const amount = Number(args[args.indexOf("--amount") + 1]);
        nestedRatio += args.includes("left") ? -amount : amount;
        nestedRatio = Math.max(0.1, Math.min(0.9, nestedRatio));
        boardWidth =
          nestedSplitWidth - Math.round(nestedSplitWidth * nestedRatio);
      }
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const controller = new FirstMateTodoPaneController(
    herdr,
    await runtimeStore(),
  );

  await controller.ensure({
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  });

  assert.equal(boardWidth, targetWidth);
  const resizeCalls = calls.filter(
    (args) => args[0] === "pane" && args[1] === "resize",
  );
  assert.equal(resizeCalls.length, 5);
  assert.equal(
    resizeCalls.at(-1)?.[resizeCalls.at(-1)!.indexOf("--direction") + 1],
    "right",
  );
  assert.equal(herdr.currentFocus, "w1:p1");
  assert.deepEqual(herdr.focusCalls, []);
});

test("nested width restoration stops at its convergence bound", async () => {
  const calls: string[][] = [];
  let boardAtRight = false;
  let boardWidth = 40;
  let herdr!: FocusTrackingHerdrClient;
  const runtime = await runtimeStore();
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: boardAtRight
            ? layout([
                { pane_id: "w1:p3", x: 0, width: 40 },
                { pane_id: "w1:p1", x: 40, width: 60 - boardWidth },
                {
                  pane_id: "w1:p2",
                  x: 100 - boardWidth,
                  width: boardWidth,
                },
              ])
            : layout([
                { pane_id: "w1:p2", x: 0, width: 40 },
                { pane_id: "w1:p1", x: 40, width: 40 },
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
      if (args[0] === "pane" && args[1] === "swap") {
        boardAtRight = true;
        boardWidth = 20;
      }
      if (args[0] === "pane" && args[1] === "resize")
        boardWidth = boardWidth === 20 ? 21 : 20;
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  herdr = new FocusTrackingHerdrClient(runner, "w1:p1");
  const controller = new FirstMateTodoPaneController(herdr, runtime);

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
    calls.filter((args) => args[0] === "pane" && args[1] === "resize").length,
    12,
  );
  assert.equal((await runtime.read()).paneId, "w1:p2");
  assert.equal(herdr.currentFocus, "w1:p1");
  assert.deepEqual(herdr.focusCalls, []);
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

test("repeated task-assignment-like reconciliation never focuses the board", async () => {
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
  assert.deepEqual(herdr.focusCalls, []);
});

test("reload restart preserves manual width and intentional focus", async () => {
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
  assert.deepEqual(herdr.focusCalls, []);
});
