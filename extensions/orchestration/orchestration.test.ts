import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CliRunner } from "./cli.ts";
import { findString } from "./cli.ts";
import { isAutoCloseStatus, needsInspection } from "./domain.ts";
import { buildHarnessLaunch } from "./harnesses.ts";
import { HerdrClient } from "./herdr-client.ts";
import { buildAgentName, OrchestrationManager } from "./manager.ts";
import { resolveIsolation, resolvePlacement } from "./placement.ts";
import { TaskRegistry } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";
import { extractFinalJson } from "./workflows/index.ts";

test("auto isolation is conservative", () => {
  assert.equal(
    resolveIsolation("auto", "Review the authentication code read-only"),
    "shared",
  );
  assert.equal(
    resolveIsolation("auto", "Implement the authentication fix"),
    "treehouse",
  );
  assert.equal(resolveIsolation("auto", "Investigate and fix it"), "treehouse");
});

test("durable and uncertain placement defaults to tab", () => {
  assert.equal(
    resolvePlacement({ requested: "auto", kind: "subagent" }),
    "tab",
  );
  assert.equal(
    resolvePlacement({ requested: "pane", kind: "background" }),
    "pane",
  );
});

test("harness defaults and native arguments", () => {
  assert.deepEqual(buildHarnessLaunch({ harness: "claude" }).args.slice(0, 4), [
    "--model",
    "fable",
    "--effort",
    "high",
  ]);
  const codex = buildHarnessLaunch({ harness: "codex" });
  assert.equal(codex.model, "gpt-5.6-sol");
  assert.ok(codex.args.includes('model_reasoning_effort="high"'));
  const pi = buildHarnessLaunch({
    harness: "pi",
    parentModel: "openai/gpt",
    parentReasoning: "medium",
  });
  assert.equal(pi.model, "openai/gpt");
  assert.ok(pi.args.includes("--exclude-tools"));
});

test("Herdr JSON IDs are decoded through response envelopes", () => {
  assert.equal(
    findString({ result: { pane: { pane_id: "w1:p2" } } }, ["pane_id"]),
    "w1:p2",
  );
});

test("Herdr agent names stay valid and within the 32-character limit", () => {
  const name = buildAgentName(
    "sa-1d20b2438e",
    "Admin Workflow Review With A Long Name",
  );
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(name.startsWith("sa-1d20b2438e-admin-"));
  assert.equal(buildAgentName("sa-1d20b2438e", "!!!"), "sa-1d20b2438e");
});

test("Herdr uses the returned root pane and retries while its shell starts", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let starts = 0;
  const runner: CliRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === "tab" && args[1] === "create")
        return {
          stdout: JSON.stringify({
            result: {
              tab: { tab_id: "w1:t2" },
              root_pane: { pane_id: "w1:p2" },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "start") {
        starts++;
        if (starts < 3)
          return {
            stdout: "",
            stderr:
              '{"error":{"code":"agent_pane_busy","message":"not ready"}}',
            code: 1,
          };
        return {
          stdout: JSON.stringify({ result: { agent_status: "idle" } }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  };
  const client = new HerdrClient(runner);
  const resource = await client.createResource(
    { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
    "tab",
    "/tmp",
    "review",
  );
  await client.startAgent("sa-123-review", "codex", resource.paneId, []);

  assert.equal(resource.paneId, "w1:p2");
  assert.equal(starts, 3);
  assert.equal(
    calls.some((call) => call.args[0] === "pane" && call.args[1] === "list"),
    false,
  );
});

test("Treehouse initializes, acquires, and guarded-returns without force", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let gets = 0;
  const runner: CliRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === "git") return { stdout: "/repo\n", stderr: "", code: 0 };
      if (args[0] === "get" && gets++ === 0)
        return { stdout: "", stderr: "not initialized", code: 1 };
      if (args[0] === "init") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "get")
        return {
          stdout: JSON.stringify({ path: "/lease", lease_id: "lease-1" }),
          stderr: "",
          code: 0,
        };
      return { stdout: "returned", stderr: "", code: 0 };
    },
  };
  const client = new TreehouseClient(runner);
  const lease = await client.acquire("/repo", "holder");
  await client.returnLease(lease);
  assert.ok(calls.some((call) => call.args[0] === "init"));
  const returned = calls.find((call) => call.args[0] === "return")!;
  assert.ok(returned.args.includes("--if-lease-id"));
  assert.ok(returned.args.includes("--if-lease-holder"));
  assert.ok(!returned.args.includes("--force"));
});

test("registry writes private durable JSON atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-registry-"));
  const path = join(directory, "registry.json");
  const registry = new TaskRegistry(path);
  const now = Date.now();
  await registry.put({
    id: "bg-1",
    label: "test",
    kind: "background",
    parentWorkspaceId: "w",
    parentTabId: "t",
    parentPaneId: "p",
    paneId: "p2",
    createdTab: false,
    createdPane: true,
    cwd: "/tmp",
    placement: "pane",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await registry.update("bg-1", { status: "done" });
  assert.equal((await registry.get("bg-1"))?.status, "done");
  assert.match(await readFile(path, "utf8"), /"bg-1"/);
});

test("completed and failed tasks are eligible for auto-close", () => {
  assert.equal(isAutoCloseStatus("done"), true);
  assert.equal(isAutoCloseStatus("failed"), true);
  assert.equal(isAutoCloseStatus("blocked"), false);
  assert.equal(isAutoCloseStatus("cancelled"), false);
});

test("auto-closed failures no longer require inspection", () => {
  const now = Date.now();
  const task = {
    id: "sa-failed",
    label: "review",
    kind: "subagent" as const,
    parentWorkspaceId: "w",
    parentTabId: "w:t1",
    parentPaneId: "w:p1",
    tabId: "w:t2",
    paneId: "w:p2",
    createdTab: true,
    createdPane: true,
    cwd: "/tmp",
    placement: "tab" as const,
    status: "failed" as const,
    createdAt: now - 40_000,
    updatedAt: now - 40_000,
    settledAt: now - 40_000,
    autoCloseAt: now - 10_000,
  };
  assert.equal(needsInspection(task, now), false);
  assert.equal(
    needsInspection({ ...task, autoCloseCancelled: true }, now),
    true,
  );
  assert.equal(needsInspection({ ...task, status: "blocked" }, now), true);
});

test("settled task output survives after its Herdr agent exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-output-"));
  const resultPath = join(directory, "child-result.txt");
  await writeFile(resultPath, "complete child review\n");
  const registry = new TaskRegistry(join(directory, "registry.json"));
  const now = Date.now();
  await registry.put({
    id: "sa-done",
    label: "review",
    kind: "subagent",
    parentWorkspaceId: "w",
    parentTabId: "w:t1",
    parentPaneId: "w:p1",
    tabId: "w:t2",
    paneId: "w:p2",
    createdTab: true,
    createdPane: true,
    agentName: "sa-done-review",
    cwd: "/tmp",
    placement: "tab",
    status: "done",
    createdAt: now,
    updatedAt: now,
    settledAt: now,
    completionResultPath: resultPath,
  });
  const calls: Array<readonly string[]> = [];
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push(args);
      return { stdout: "", stderr: "agent not found", code: 1 };
    },
  };
  const manager = new OrchestrationManager(
    new HerdrClient(runner),
    new TreehouseClient(runner),
    registry,
    { onComplete() {} },
  );
  const previousStateDirectory = process.env.PI_HERDR_STATE_DIR;
  process.env.PI_HERDR_STATE_DIR = directory;
  try {
    assert.equal(await manager.output("sa-done"), "complete child review\n");
  } finally {
    if (previousStateDirectory === undefined)
      delete process.env.PI_HERDR_STATE_DIR;
    else process.env.PI_HERDR_STATE_DIR = previousStateDirectory;
  }
  assert.deepEqual(calls, []);
});

test("reconciliation closes failed tasks whose deadline passed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-autoclose-"));
  const registry = new TaskRegistry(join(directory, "registry.json"));
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CliRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return { stdout: "{}", stderr: "", code: 0 };
    },
  };
  let changes = 0;
  const manager = new OrchestrationManager(
    new HerdrClient(runner),
    new TreehouseClient(runner),
    registry,
    { onComplete() {}, onChange: () => changes++ },
  );
  const now = Date.now();
  await registry.put({
    id: "bg-failed",
    label: "failed command",
    kind: "background",
    parentWorkspaceId: "w",
    parentTabId: "w:t1",
    parentPaneId: "w:p1",
    tabId: "w:t2",
    paneId: "w:p2",
    createdTab: true,
    createdPane: true,
    cwd: "/tmp",
    placement: "tab",
    status: "failed",
    createdAt: now - 32_000,
    updatedAt: now - 31_000,
    settledAt: now - 31_000,
  });

  const previousHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    await manager.reconcile();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        calls.some(
          (call) =>
            call.command === "herdr" &&
            call.args[0] === "tab" &&
            call.args[1] === "close" &&
            call.args[2] === "w:t2",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
  }

  assert.ok(
    calls.some(
      (call) =>
        call.command === "herdr" &&
        call.args[0] === "tab" &&
        call.args[1] === "close" &&
        call.args[2] === "w:t2",
    ),
  );
  assert.equal(changes, 1);
});

test("structured workflow output takes the final schema-matching JSON", () => {
  const value = extractFinalJson('notes\n{"ok":true}', {
    type: "object",
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  });
  assert.deepEqual(value, { ok: true });
  assert.throws(() =>
    extractFinalJson('{"ok":"yes"}', {
      type: "object",
      properties: { ok: { type: "boolean" } },
    }),
  );
});
