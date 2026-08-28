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

interface LayoutPane {
  pane_id: string;
  x: number;
  width: number;
}

function layout(
  panes: LayoutPane[],
  location = { workspaceId: "w1", tabId: "w1:t1" },
) {
  return JSON.stringify({
    result: {
      layout: {
        workspace_id: location.workspaceId,
        tab_id: location.tabId,
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

interface FakeTodoPane extends LayoutPane {
  commandLine: string;
  label?: string;
  processError?: string;
  visible?: boolean;
}

class TodoPaneFakeRunner implements CliRunner {
  readonly calls: string[][] = [];
  readonly panes = new Map<string, FakeTodoPane>();
  readonly firstLayoutEntered: Promise<void>;
  layoutCalls = 0;
  layoutGate: Promise<void> | undefined;
  private markFirstLayoutEntered!: () => void;
  private nextPaneNumber: number;
  private readonly location: { workspaceId: string; tabId: string };

  constructor(
    panes: FakeTodoPane[],
    location = { workspaceId: "w1", tabId: "w1:t1" },
  ) {
    this.location = location;
    for (const pane of panes) this.panes.set(pane.pane_id, { ...pane });
    this.nextPaneNumber =
      Math.max(
        1,
        ...panes.map((pane) => Number(pane.pane_id.match(/p(\d+)$/)?.[1] ?? 0)),
      ) + 1;
    this.firstLayoutEntered = new Promise((resolve) => {
      this.markFirstLayoutEntered = resolve;
    });
  }

  async run(_command: string, args: readonly string[]) {
    this.calls.push([...args]);
    const ok = (value: unknown = {}) => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ result: value }),
    });
    if (args[0] !== "pane") return ok();
    if (args[1] === "layout") {
      this.layoutCalls += 1;
      this.markFirstLayoutEntered();
      const snapshot = [...this.panes.values()]
        .filter((pane) => pane.visible !== false)
        .map(({ pane_id, x, width }) => ({
          pane_id,
          x,
          width,
        }));
      await this.layoutGate;
      return {
        code: 0,
        stderr: "",
        stdout: layout(snapshot, this.location),
      };
    }
    if (args[1] === "list")
      return ok({
        panes: [...this.panes.values()]
          .filter((pane) => pane.visible !== false)
          .map((pane) => ({
            pane_id: pane.pane_id,
            workspace_id: this.location.workspaceId,
            tab_id: this.location.tabId,
            label: pane.label,
            focused: pane.pane_id === "w1:p1",
          })),
      });
    if (args[1] === "process-info") {
      const paneId = String(args.at(-1));
      const pane = this.panes.get(paneId);
      if (!pane) return { code: 1, stderr: "pane not found", stdout: "" };
      if (pane.processError)
        return { code: 1, stderr: pane.processError, stdout: "" };
      return ok({
        process_info: {
          pane_id: paneId,
          foreground_processes: [{ cmdline: pane.commandLine }],
        },
      });
    }
    if (args[1] === "get")
      return this.panes.has(String(args[2]))
        ? ok()
        : { code: 1, stderr: "pane not found", stdout: "" };
    if (args[1] === "split") {
      const paneId = `w1:p${this.nextPaneNumber++}`;
      this.panes.set(paneId, {
        pane_id: paneId,
        x: 100,
        width: 25,
        commandLine: "bash",
      });
      return ok({ pane: { pane_id: paneId } });
    }
    if (args[1] === "rename") {
      const pane = this.panes.get(String(args[2]));
      if (pane) pane.label = String(args[3]);
      return ok();
    }
    if (args[1] === "run") {
      const pane = this.panes.get(String(args[2]));
      if (pane) pane.commandLine = String(args[3]);
      return ok();
    }
    if (args[1] === "send-keys") {
      const pane = this.panes.get(String(args[2]));
      if (pane) pane.commandLine = "bash";
      return ok();
    }
    if (args[1] === "close") {
      this.panes.delete(String(args[2]));
      return ok();
    }
    return ok();
  }
}

async function runtimeStore() {
  const directory = await mkdtemp(join(tmpdir(), "pi-first-mate-todo-pane-"));
  return new TodoPaneRuntimeStore(join(directory, "runtime.json"));
}

function assertNoPaneGeometryOrFocusMutations(calls: string[][]) {
  assert.deepEqual(
    calls.filter(
      (args) =>
        (args[0] === "pane" &&
          (args[1] === "swap" ||
            args[1] === "resize" ||
            args[1] === "focus")) ||
        ((args[0] === "tab" || args[0] === "workspace") && args[1] === "focus"),
    ),
    [],
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
  assertNoPaneGeometryOrFocusMutations(calls);
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

test("duplicate running boards deterministically reduce to one without splitting", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 55, commandLine: "pi" },
    { pane_id: "w1:p2", x: 55, width: 20, commandLine: boardProcess() },
    { pane_id: "w1:p3", x: 75, width: 15, commandLine: boardProcess() },
    { pane_id: "w1:p4", x: 90, width: 10, commandLine: "vim notes.txt" },
  ]);
  const runtime = await runtimeStore();
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    runtime,
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
    paneId: "w1:p3",
    created: false,
    restarted: false,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(
    fake.calls
      .filter((args) => args[0] === "pane" && args[1] === "close")
      .map((args) => args[2]),
    ["w1:p2"],
  );
  assert.equal(fake.panes.has("w1:p4"), true);
  assert.equal(
    fake.calls.some((args) => args[0] === "pane" && args[1] === "split"),
    false,
  );
  assert.equal((await runtime.read()).paneId, "w1:p3");
});

test("concurrent fresh controllers serialize creation and yield one board", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 100, commandLine: "pi" },
  ]);
  let releaseLayout!: () => void;
  fake.layoutGate = new Promise((resolve) => {
    releaseLayout = resolve;
  });
  const firstRuntime = await runtimeStore();
  const secondRuntime = new TodoPaneRuntimeStore(firstRuntime.path);
  const firstController = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    firstRuntime,
  );
  const secondController = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    secondRuntime,
  );
  const location = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  const firstEnsure = firstController.ensure(location);
  await fake.firstLayoutEntered;
  const secondEnsure = secondController.ensure(location);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.layoutCalls, 1);
  releaseLayout();
  const [first, second] = await Promise.all([firstEnsure, secondEnsure]);

  assert.deepEqual(first, {
    paneId: "w1:p2",
    created: true,
    restarted: true,
  });
  assert.deepEqual(second, {
    paneId: "w1:p2",
    created: false,
    restarted: false,
  });
  assert.equal(
    fake.calls.filter((args) => args[0] === "pane" && args[1] === "split")
      .length,
    1,
  );
});

test("exact-labeled idle crash remnant is reused and remains idempotent", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 75, commandLine: "pi" },
    {
      pane_id: "w1:p2",
      x: 75,
      width: 25,
      label: "firstmate-todo",
      commandLine: "bash",
    },
  ]);
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    await runtimeStore(),
  );
  const location = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  assert.deepEqual(await controller.ensure(location), {
    paneId: "w1:p2",
    created: false,
    restarted: true,
  });
  assert.deepEqual(await controller.ensure(location), {
    paneId: "w1:p2",
    created: false,
    restarted: false,
  });
  assert.equal(
    fake.calls.filter((args) => args[0] === "pane" && args[1] === "run").length,
    1,
  );
  assert.equal(
    fake.calls.some((args) => args[0] === "pane" && args[1] === "split"),
    false,
  );
  assert.ok(
    fake.calls.some(
      (args) =>
        args[0] === "pane" &&
        args[1] === "list" &&
        args.includes("--workspace") &&
        args.includes("w1"),
    ),
  );
});

test("persisted candidate inspection failure aborts without creating or mutating panes", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 75, commandLine: "pi" },
    {
      pane_id: "w1:p2",
      x: 75,
      width: 25,
      commandLine: boardProcess(),
      processError: "process inspection failed",
    },
  ]);
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
  });
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    runtime,
  );

  await assert.rejects(
    controller.ensure({
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      cwd: "/repo",
    }),
    /Could not inspect first-mate to-do pane candidate w1:p2/,
  );
  assert.deepEqual(
    fake.calls.filter(
      (args) =>
        args[0] === "pane" &&
        (args[1] === "split" ||
          args[1] === "close" ||
          args[1] === "run" ||
          args[1] === "send-keys"),
    ),
    [],
  );
});

test("exact-labeled candidate inspection failure aborts without creating or mutating panes", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 75, commandLine: "pi" },
    {
      pane_id: "w1:p2",
      x: 75,
      width: 25,
      label: "firstmate-todo",
      commandLine: "bash",
      processError: "process inspection failed",
    },
  ]);
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    await runtimeStore(),
  );

  await assert.rejects(
    controller.ensure({
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      cwd: "/repo",
    }),
    /Could not inspect first-mate to-do pane candidate w1:p2/,
  );
  assert.deepEqual(
    fake.calls.filter(
      (args) =>
        args[0] === "pane" &&
        (args[1] === "split" ||
          args[1] === "close" ||
          args[1] === "run" ||
          args[1] === "send-keys"),
    ),
    [],
  );
});

test("exact-labeled active non-board process is never closed or replaced", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 75, commandLine: "pi" },
    {
      pane_id: "w1:p2",
      x: 75,
      width: 25,
      label: "firstmate-todo",
      commandLine: "vim important.txt",
    },
  ]);
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    await runtimeStore(),
  );

  assert.deepEqual(
    await controller.ensure({
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      cwd: "/repo",
    }),
    { paneId: "w1:p3", created: true, restarted: true },
  );
  assert.equal(fake.panes.get("w1:p2")?.commandLine, "vim important.txt");
  assert.equal(
    fake.calls.some(
      (args) =>
        args[0] === "pane" &&
        args[2] === "w1:p2" &&
        (args[1] === "close" || args[1] === "run" || args[1] === "send-keys"),
    ),
    false,
  );
});

test("reconciliation closes exact-label and CLI-marker duplicates only", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 50, commandLine: "pi" },
    { pane_id: "w1:p2", x: 50, width: 15, commandLine: boardProcess() },
    {
      pane_id: "w1:p3",
      x: 65,
      width: 10,
      label: "firstmate-todo",
      commandLine: "bash",
    },
    { pane_id: "w1:p4", x: 75, width: 10, commandLine: boardProcess() },
    {
      pane_id: "w1:p5",
      x: 85,
      width: 15,
      label: "firstmate-todo",
      commandLine: "bash run-user-job",
    },
  ]);
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w1:p2",
    parentPaneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
  });
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    runtime,
  );

  assert.deepEqual(
    await controller.ensure({
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      cwd: "/repo",
    }),
    { paneId: "w1:p2", created: false, restarted: false },
  );
  assert.deepEqual(
    fake.calls
      .filter((args) => args[0] === "pane" && args[1] === "close")
      .map((args) => args[2]),
    ["w1:p4", "w1:p3"],
  );
  assert.equal(fake.panes.has("w1:p5"), true);
});

test("reconciliation does not sweep other tabs or workspaces", async () => {
  const fake = new TodoPaneFakeRunner([
    { pane_id: "w1:p1", x: 0, width: 100, commandLine: "pi" },
    {
      pane_id: "w2:p9",
      x: 0,
      width: 25,
      commandLine: boardProcess(),
      visible: false,
    },
    {
      pane_id: "w3:p10",
      x: 0,
      width: 25,
      commandLine: boardProcess(),
      visible: false,
    },
  ]);
  const runtime = await runtimeStore();
  await runtime.write({
    version: 1,
    paneId: "w2:p9",
    parentPaneId: "w2:p1",
    tabId: "w2:t4",
    workspaceId: "w2",
  });
  const controller = new FirstMateTodoPaneController(
    new HerdrClient(fake),
    runtime,
  );

  assert.deepEqual(
    await controller.ensure({
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      cwd: "/repo",
    }),
    { paneId: "w1:p11", created: true, restarted: true },
  );
  assert.equal(fake.panes.has("w2:p9"), false);
  assert.equal(fake.panes.has("w3:p10"), true);
  assert.equal(
    fake.calls.some(
      (args) => args[1] === "process-info" && args.at(-1) === "w3:p10",
    ),
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

test("ensure reuses a non-rightmost board without changing nested geometry or focus", async () => {
  const calls: string[][] = [];
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p1", x: 0, width: 37 },
            { pane_id: "w1:p2", x: 37, width: 18 },
            { pane_id: "w1:p3", x: 55, width: 65 },
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
  herdr = new FocusTrackingHerdrClient(runner, "w1:p3");
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
  assert.equal((await runtime.read()).paneId, "w1:p2");
  assertNoPaneGeometryOrFocusMutations(calls);
  assert.equal(herdr.currentFocus, "w1:p3");
  assert.deepEqual(herdr.focusCalls, []);
});

test("fresh controller after process restart leaves non-rightmost geometry and focus untouched", async () => {
  const calls: string[][] = [];
  let processExited = false;
  let herdr!: FocusTrackingHerdrClient;
  const runtime = await runtimeStore();
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
            { pane_id: "w1:p1", x: 0, width: 24 },
            { pane_id: "w1:p2", x: 24, width: 51 },
            { pane_id: "w1:p3", x: 75, width: 45 },
          ]),
        };
      if (args[0] === "pane" && args[1] === "list")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              panes: [
                {
                  workspace_id: "w1",
                  tab_id: "w1:t1",
                  pane_id: "w1:p1",
                  label: "",
                },
                {
                  workspace_id: "w1",
                  tab_id: "w1:t1",
                  pane_id: "w1:p2",
                  label: "firstmate-todo",
                },
                {
                  workspace_id: "w1",
                  tab_id: "w1:t1",
                  pane_id: "w1:p3",
                  label: "",
                },
              ],
            },
          }),
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
                      args.at(-1) === "w1:p2" && !processExited
                        ? boardProcess()
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
  herdr = new FocusTrackingHerdrClient(runner, "w1:p3");
  const controller = new FirstMateTodoPaneController(herdr, runtime);
  const location = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  assert.deepEqual(await controller.ensure(location), {
    paneId: "w1:p2",
    created: false,
    restarted: false,
  });
  processExited = true;
  const freshController = new FirstMateTodoPaneController(herdr, runtime);
  assert.deepEqual(await freshController.ensure(location), {
    paneId: "w1:p2",
    created: false,
    restarted: true,
  });
  assert.equal(
    calls.filter(
      (args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p2",
    ).length,
    1,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "split"),
    false,
  );
  assertNoPaneGeometryOrFocusMutations(calls);
  assert.equal(herdr.currentFocus, "w1:p3");
  assert.deepEqual(herdr.focusCalls, []);
});

test("repeated reconciliation leaves unequal nested geometry and focus untouched", async () => {
  const calls: string[][] = [];
  let herdr!: FocusTrackingHerdrClient;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "layout")
        return {
          code: 0,
          stderr: "",
          stdout: layout([
            { pane_id: "w1:p1", x: 0, width: 65 },
            { pane_id: "w1:p2", x: 65, width: 10 },
            { pane_id: "w1:p3", x: 75, width: 45 },
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
  assertNoPaneGeometryOrFocusMutations(calls);
  assert.deepEqual(herdr.focusCalls, []);
});

test("reload restart leaves a non-rightmost board and intentional focus untouched", async () => {
  const calls: string[][] = [];
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
            { pane_id: "w1:p2", x: 0, width: 43 },
            { pane_id: "w1:p1", x: 43, width: 31 },
            { pane_id: "w1:p3", x: 74, width: 46 },
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
                        ? stopped
                          ? "bash"
                          : boardProcess("older-source")
                        : "bash",
                  },
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
    restarted: true,
  });
  assert.equal((await runtime.read()).paneId, "w1:p2");
  assertNoPaneGeometryOrFocusMutations(calls);
  assert.equal(herdr.currentFocus, "w1:p2");
  assert.deepEqual(herdr.focusCalls, []);
});
