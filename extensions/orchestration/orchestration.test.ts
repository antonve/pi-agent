import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CliRunner } from "./cli.ts";
import { findNumber, findString, nodeCliRunner } from "./cli.ts";
import {
  isAutoCloseStatus,
  needsInspection,
  type TaskRecord,
} from "./domain.ts";
import { buildHarnessLaunch } from "./harnesses.ts";
import { HerdrClient } from "./herdr-client.ts";
import {
  BackgroundWaitRegistry,
  createBackgroundWaitExecutor,
} from "../shared/background-waits.ts";
import orchestration, {
  CompletionSuppression,
  deliverTaskCompletion,
  registerSubagentWait,
  registerWaitableSubagent,
  renderFirstMateControlMessage,
  renderHerdrTaskResult,
} from "./index.ts";
import {
  advanceAgentLifecycle,
  BACKGROUND_SNAPSHOT_VARIABLE,
  buildAgentName,
  buildBackgroundScript,
  buildChildPrompt,
  CANCEL_CLOSE_MS,
  extractFinalBackgroundSnapshot,
  extractParentReport,
  OrchestrationManager,
  PARENT_REPORT_END,
  PARENT_REPORT_START,
  stripBackgroundSnapshotMarkers,
} from "./manager.ts";
import { resolveIsolation, resolvePlacement } from "./placement.ts";
import { TaskRegistry } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";
import { extractFinalJson } from "./workflows/index.ts";

function renderedLines(component: Component) {
  return component
    .render(120)
    .map((line) => line.trim())
    .filter(Boolean);
}

function agentResponse(options: {
  status: string;
  seq: number;
  ready?: boolean;
  pending?: boolean;
  harness?: string;
  paneId?: string;
  session?: string;
  name?: string;
}) {
  return JSON.stringify({
    result: {
      agent: {
        agent: options.harness ?? "opencode",
        agent_status: options.status,
        pane_id: options.paneId ?? "w1:p2",
        state_change_seq: options.seq,
        interactive_ready: options.ready ?? true,
        launch_pending: options.pending ?? false,
        name: options.name,
        agent_session: {
          value: options.session ?? "session-1",
        },
      },
    },
  });
}

const FAST_HERDR_TIMING = {
  agentStartBusyRetries: 3,
  agentStartRetryMs: 1,
  promptReadyPollMs: 1,
  promptReadyConsecutiveReads: 2,
  promptReadyTimeoutMs: 500,
  promptActivityTimeoutMs: 20,
  promptLateActivityMs: 30,
  promptDeliveryAttempts: 3,
};

function registeredOrchestrationTools() {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    events: {},
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    registerMessageRenderer() {},
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI;
  orchestration(pi);
  return tools;
}

async function withHerdrSocket<T>(
  run: (requests: Array<Record<string, unknown>>) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-socket-"));
  const socketPath = join(directory, "herdr.sock");
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        connection.write(
          `${JSON.stringify({ id: request.id, result: { ok: true } })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  const previousSocketPath = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socketPath;
  try {
    return await run(requests);
  } finally {
    if (previousSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocketPath;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  }
}

function registeredOrchestrationRuntime() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: any) => unknown }
  >();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = {
    events: {},
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    registerMessageRenderer() {},
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: any) => unknown },
    ) {
      commands.set(name, options);
    },
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;
  orchestration(pi);
  return { tools, commands, handlers };
}

function taskRecord(id: string, status: TaskRecord["status"]): TaskRecord {
  const now = Date.now();
  return {
    id,
    label: `task ${id}`,
    kind: "subagent",
    parentWorkspaceId: "workspace-1",
    parentTabId: "tab-1",
    parentPaneId: "pane-1",
    paneId: `pane-${id}`,
    createdTab: true,
    createdPane: false,
    cwd: "/tmp/project",
    placement: "tab",
    status,
    createdAt: now,
    updatedAt: now,
  };
}

test("slash-command firstmate claim makes later turns explicitly supervisory", async () => {
  await withHerdrSocket(async (requests) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-firstmate-claim-turn-"));
    const previousStateDir = process.env.PI_HERDR_STATE_DIR;
    const previousRole = process.env.PI_FIRST_MATE_ROLE;
    const previousTaskId = process.env.PI_FIRST_MATE_TASK_ID;
    const previousRun = nodeCliRunner.run;
    const calls: string[][] = [];
    process.env.PI_HERDR_STATE_DIR = directory;
    delete process.env.PI_FIRST_MATE_ROLE;
    delete process.env.PI_FIRST_MATE_TASK_ID;
    nodeCliRunner.run = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "current")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              workspace_id: "w-owner",
              tab_id: "w-owner:t1",
              pane_id: "w-owner:p1",
            },
          }),
        };
      if (args[0] === "workspace" && args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              workspace: { workspace_id: "w-owner", focused: true },
            },
          }),
        };
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ result: {} }),
      };
    };
    try {
      const runtime = registeredOrchestrationRuntime();
      const claim = runtime.commands.get("firstmate")?.handler;
      const beforeAgentStart = runtime.handlers.get("before_agent_start")?.[0];
      assert.ok(claim);
      assert.ok(beforeAgentStart);

      const notifications: string[] = [];
      const ctx = {
        cwd: "/repo",
        mode: "tui",
        hasUI: true,
        sessionManager: {
          getSessionId: () => "first-mate-session",
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      };

      await claim!("claim", ctx);

      const promptUpdate = (await beforeAgentStart!(
        {
          prompt: "Please fix the repository bug",
          images: [],
          systemPrompt: "BASE",
          systemPromptOptions: {},
        },
        ctx,
      )) as { systemPrompt?: string } | undefined;

      assert.equal(notifications.length, 1);
      assert.match(
        notifications[0] ?? "",
        /First mate claimed by first-mate-session/,
      );
      assert.match(promptUpdate?.systemPrompt ?? "", /task_assign/);
      assert.match(
        promptUpdate?.systemPrompt ?? "",
        /before inspecting files, acquiring a Treehouse lease, editing code/i,
      );
      assert.match(
        promptUpdate?.systemPrompt ?? "",
        /Stay in the supervisory first-mate role/,
      );
      assert.match(
        promptUpdate?.systemPrompt ?? "",
        /Delegated second mates own detailed planning, `~\/xdev\/plans` persistence and updates/i,
      );
      assert.match(
        promptUpdate?.systemPrompt ?? "",
        /concise decisions and portfolio status; do not write detailed task plans or perform task research yourself/i,
      );
      assert.match(
        promptUpdate?.systemPrompt ?? "",
        /Do not perform task-specific Linear discovery or writes, including issue creation, description edits, comments, relations, or workflow transitions/i,
      );
      assert.match(
        promptUpdate?.systemPrompt ?? "",
        /Pass concise user Linear requests and decisions to the owning second mate with task_send; when no second mate owns the work, use task_assign to delegate a short Linear task/i,
      );
      assert.match(
        promptUpdate?.systemPrompt ?? "",
        /keep the delegated task active or resume it instead of terminally completing it/i,
      );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "workspace" &&
            args[1] === "rename" &&
            args[2] === "w-owner" &&
            args[3] === "firstmate",
        ),
      );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "tab" &&
            args[1] === "rename" &&
            args[2] === "w-owner:t1" &&
            args[3] === "firstmate",
        ),
      );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "workspace" &&
            args[1] === "report-metadata" &&
            args[2] === "w-owner" &&
            args.includes("repo=repo"),
        ),
      );
      assert.deepEqual(
        requests.map((request) => ({
          method: request.method,
          params: request.params,
        })),
        [
          {
            method: "workspace.move",
            params: { workspace_id: "w-owner", insert_index: 0 },
          },
          { method: "pane.focus", params: { pane_id: "w-owner:p1" } },
        ],
      );

      const fleet = JSON.parse(
        await readFile(join(directory, "fleet.json"), "utf8"),
      ) as {
        firstMate?: { sessionId?: string };
      };
      assert.equal(fleet.firstMate?.sessionId, "first-mate-session");
    } finally {
      nodeCliRunner.run = previousRun;
      if (previousStateDir === undefined) delete process.env.PI_HERDR_STATE_DIR;
      else process.env.PI_HERDR_STATE_DIR = previousStateDir;
      if (previousRole === undefined) delete process.env.PI_FIRST_MATE_ROLE;
      else process.env.PI_FIRST_MATE_ROLE = previousRole;
      if (previousTaskId === undefined)
        delete process.env.PI_FIRST_MATE_TASK_ID;
      else process.env.PI_FIRST_MATE_TASK_ID = previousTaskId;
    }
  });
});

test("tool first_mate_claim renames and reorders the claimed workspace", async () => {
  await withHerdrSocket(async (requests) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-firstmate-tool-claim-"));
    const previousStateDir = process.env.PI_HERDR_STATE_DIR;
    const previousRole = process.env.PI_FIRST_MATE_ROLE;
    const previousTaskId = process.env.PI_FIRST_MATE_TASK_ID;
    const previousRun = nodeCliRunner.run;
    const calls: string[][] = [];
    process.env.PI_HERDR_STATE_DIR = directory;
    delete process.env.PI_FIRST_MATE_ROLE;
    delete process.env.PI_FIRST_MATE_TASK_ID;
    nodeCliRunner.run = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "current")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              workspace_id: "w-owner",
              tab_id: "w-owner:t1",
              pane_id: "w-owner:p1",
            },
          }),
        };
      if (args[0] === "workspace" && args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              workspace: { workspace_id: "w-owner", focused: true },
            },
          }),
        };
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ result: {} }),
      };
    };
    try {
      const runtime = registeredOrchestrationRuntime();
      const claim = runtime.tools.get("first_mate_claim");
      assert.ok(claim);
      const result = await claim.execute("call-1", {}, undefined, undefined, {
        cwd: "/repo",
        mode: "tui",
        hasUI: true,
        sessionManager: {
          getSessionId: () => "first-mate-session",
        },
      } as never);
      assert.match(
        result.content[0]?.type === "text" ? result.content[0].text : "",
        /Claimed the machine first-mate role/,
      );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "workspace" &&
            args[1] === "rename" &&
            args[2] === "w-owner" &&
            args[3] === "firstmate",
        ),
      );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "tab" &&
            args[1] === "rename" &&
            args[2] === "w-owner:t1" &&
            args[3] === "firstmate",
        ),
      );
      assert.deepEqual(
        requests.map((request) => ({
          method: request.method,
          params: request.params,
        })),
        [
          {
            method: "workspace.move",
            params: { workspace_id: "w-owner", insert_index: 0 },
          },
          { method: "pane.focus", params: { pane_id: "w-owner:p1" } },
        ],
      );
    } finally {
      nodeCliRunner.run = previousRun;
      if (previousStateDir === undefined) delete process.env.PI_HERDR_STATE_DIR;
      else process.env.PI_HERDR_STATE_DIR = previousStateDir;
      if (previousRole === undefined) delete process.env.PI_FIRST_MATE_ROLE;
      else process.env.PI_FIRST_MATE_ROLE = previousRole;
      if (previousTaskId === undefined)
        delete process.env.PI_FIRST_MATE_TASK_ID;
      else process.env.PI_FIRST_MATE_TASK_ID = previousTaskId;
    }
  });
});

test("first-mate supervisory prompt skips leaf and second-mate sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-firstmate-role-skip-"));
  const previousStateDir = process.env.PI_HERDR_STATE_DIR;
  const previousRole = process.env.PI_FIRST_MATE_ROLE;
  const previousTaskId = process.env.PI_FIRST_MATE_TASK_ID;
  process.env.PI_HERDR_STATE_DIR = directory;
  try {
    await writeFile(
      join(directory, "fleet.json"),
      `${JSON.stringify(
        {
          version: 1,
          firstMate: {
            sessionId: "owned-session",
            workspaceId: "w-owner",
            tabId: "w-owner:t1",
            paneId: "w-owner:p1",
            claimedAt: 1,
            updatedAt: 1,
          },
          tasks: [],
          messages: [],
        },
        null,
        2,
      )}\n`,
    );

    for (const scenario of [
      { role: "leaf", taskId: undefined },
      { role: "second-mate", taskId: "TASK-1" },
    ]) {
      process.env.PI_FIRST_MATE_ROLE = scenario.role;
      if (scenario.taskId === undefined)
        delete process.env.PI_FIRST_MATE_TASK_ID;
      else process.env.PI_FIRST_MATE_TASK_ID = scenario.taskId;
      const runtime = registeredOrchestrationRuntime();
      const beforeAgentStart = runtime.handlers.get("before_agent_start")?.[0];
      assert.ok(beforeAgentStart);
      const result = await beforeAgentStart!(
        {
          prompt: "Please fix the repository bug",
          images: [],
          systemPrompt: "BASE",
          systemPromptOptions: {},
        },
        {
          sessionManager: {
            getSessionId: () => "owned-session",
          },
        },
      );
      assert.equal(result, undefined);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.PI_HERDR_STATE_DIR;
    else process.env.PI_HERDR_STATE_DIR = previousStateDir;
    if (previousRole === undefined) delete process.env.PI_FIRST_MATE_ROLE;
    else process.env.PI_FIRST_MATE_ROLE = previousRole;
    if (previousTaskId === undefined) delete process.env.PI_FIRST_MATE_TASK_ID;
    else process.env.PI_FIRST_MATE_TASK_ID = previousTaskId;
  }
});

test("completed background notifications collapse to one line", () => {
  const message = {
    role: "custom" as const,
    customType: "herdr-task-result",
    content:
      "background bg-123 “Validate” done.\n\ncommand output\nmore output",
    display: true,
    timestamp: Date.now(),
    details: {
      id: "bg-123",
      kind: "background",
      status: "done",
      label: "Validate",
    },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
  } as Theme;

  const collapsed = renderHerdrTaskResult(
    message,
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(collapsed);
  assert.deepEqual(renderedLines(collapsed), ["bg-123 done · Validate"]);

  const expanded = renderHerdrTaskResult(
    message,
    { expanded: true, outputPad: 0 },
    theme,
  );
  assert.ok(expanded);
  assert.ok(renderedLines(expanded).includes("command output"));
  assert.ok(renderedLines(expanded).includes("more output"));
});

test("completed subagent notifications collapse to one line", () => {
  const message = {
    role: "custom" as const,
    customType: "herdr-task-result",
    content: "subagent sa-123 “Review” done.\n\nagent output\nmore output",
    display: true,
    timestamp: Date.now(),
    details: {
      id: "sa-123",
      kind: "subagent",
      status: "done",
      label: "Review",
    },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
  } as Theme;

  const collapsed = renderHerdrTaskResult(
    message,
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(collapsed);
  assert.deepEqual(renderedLines(collapsed), ["sa-123 done · Review"]);

  const expanded = renderHerdrTaskResult(
    message,
    { expanded: true, outputPad: 0 },
    theme,
  );
  assert.ok(expanded);
  assert.ok(renderedLines(expanded).includes("agent output"));
  assert.ok(renderedLines(expanded).includes("more output"));
});

test("subagent wait returns immediately and delivers one grouped completion", async () => {
  const tools = new Map<string, ToolDefinition>();
  const notifications: Array<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }> = [];
  const pi = {
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    sendMessage(
      message: Parameters<ExtensionAPI["sendMessage"]>[0],
      options: Parameters<ExtensionAPI["sendMessage"]>[1],
    ) {
      notifications.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const running = [
    taskRecord("sa-one", "running"),
    taskRecord("sa-two", "running"),
  ];
  const settled = [taskRecord("sa-one", "done"), taskRecord("sa-two", "done")];
  let finishWait!: (tasks: TaskRecord[]) => void;
  const waitFinished = new Promise<TaskRecord[]>((resolve) => {
    finishWait = resolve;
  });
  const manager = {
    wait: async (ids: string[]) =>
      waitFinished.then((tasks) =>
        tasks.filter((task) => ids.includes(task.id)),
      ),
    report: async (id: string) => `output for ${id}`,
  };
  const suppression = new CompletionSuppression();
  const backgroundWaits = new BackgroundWaitRegistry();
  for (const task of running)
    registerWaitableSubagent(backgroundWaits, manager, suppression, task);
  registerSubagentWait(
    pi,
    backgroundWaits,
    createBackgroundWaitExecutor(pi, backgroundWaits),
  );

  const waitTool = tools.get("subagent_wait");
  assert.ok(waitTool);
  const result = await waitTool.execute(
    "wait-call",
    { ids: ["sa-one", "sa-two"] },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(result.terminate, true);
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /Waiting in the background/,
  );
  assert.equal(notifications.length, 0);
  assert.equal(suppression.has("sa-one"), true);
  assert.equal(suppression.has("sa-two"), true);

  finishWait(settled);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0]?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  const notification = notifications[0]?.message;
  assert.equal(notification?.customType, "background-wait-result");
  assert.match(String(notification?.content), /output for sa-one/);
  assert.match(String(notification?.content), /output for sa-two/);
  assert.equal(suppression.has("sa-one"), false);
  assert.equal(suppression.has("sa-two"), false);
});

test("grouped waits suppress individual completion notifications", () => {
  const notifications: unknown[] = [];
  const pi = {
    sendMessage(message: unknown) {
      notifications.push(message);
    },
  } as unknown as ExtensionAPI;
  const suppression = new CompletionSuppression();
  const release = suppression.acquire(["sa-one"]);
  const task = taskRecord("sa-one", "done");

  assert.equal(deliverTaskCompletion(pi, suppression, task, "output"), false);
  assert.equal(notifications.length, 0);

  release();
  assert.equal(deliverTaskCompletion(pi, suppression, task, "output"), true);
  assert.equal(notifications.length, 1);
});

test("collapsed first-mate control tools occupy one line and expand on demand", () => {
  const tools = registeredOrchestrationTools();
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const cases: Array<[string, object, string]> = [
    ["first_mate_claim", {}, "first mate claim"],
    ["first_mate_status", {}, "first mate status"],
    [
      "task_assign",
      { task_id: "task-1", title: "Review UI", brief: "Do the work" },
      "task assign task-1 Review UI",
    ],
    ["task_list", {}, "task list"],
    [
      "task_send",
      { task_id: "task-1", type: "SCOPE_UPDATE", message: "Narrow scope" },
      "task send task-1 SCOPE_UPDATE",
    ],
    [
      "task_cancel",
      { task_id: "task-1", reason: "No longer needed" },
      "task cancel task-1",
    ],
  ];
  const collapsed = {
    expanded: false,
    isError: false,
  } as never;
  const expanded = { expanded: true, isError: false } as never;
  const result = {
    content: [{ type: "text" as const, text: "Detailed tool result" }],
    details: { ok: true },
  };

  for (const [name, args, expected] of cases) {
    const tool = tools.get(name);
    assert.ok(tool?.renderCall, `${name} should render its call`);
    assert.ok(tool.renderResult, `${name} should render its result`);
    assert.equal(tool.renderShell, "self");
    assert.deepEqual(
      renderedLines(tool.renderCall(args as never, theme, collapsed)),
      [expected],
    );
    assert.deepEqual(
      renderedLines(
        tool.renderResult(
          result,
          { expanded: false, isPartial: false },
          theme,
          collapsed,
        ),
      ),
      [],
    );
    assert.ok(
      renderedLines(tool.renderCall(args as never, theme, expanded)).some(
        (line) => line.includes("{") || line.includes('"task_id"'),
      ),
    );
    const expandedLines = renderedLines(
      tool.renderResult(
        result,
        { expanded: true, isPartial: false },
        theme,
        expanded,
      ),
    );
    assert.ok(expandedLines.includes("Detailed tool result"));
    assert.ok(expandedLines.some((line) => line.includes('"ok": true')));
  }
});

test("collapsed subagent tools occupy one line and expand on demand", () => {
  const tools = registeredOrchestrationTools();
  assert.equal(tools.has("background_wait"), true);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const cases: Array<[string, object, string]> = [
    [
      "subagent_spawn",
      { prompt: "Review the code", name: "review", harness: "pi" },
      "subagent spawn review",
    ],
    [
      "subagent_wait",
      { ids: ["sa-one", "sa-two"] },
      "subagent wait sa-one, sa-two",
    ],
    ["subagent_check", { id: "sa-one" }, "subagent check sa-one"],
    ["subagent_list", {}, "subagents"],
    ["subagent_cancel", { ids: ["sa-one"] }, "subagent cancel sa-one"],
    [
      "subagent_send",
      { id: "sa-one", prompt: "Please continue" },
      "subagent send sa-one",
    ],
  ];
  const context = {
    expanded: false,
    isError: false,
  } as never;
  const result = {
    content: [{ type: "text" as const, text: "Detailed tool result" }],
    details: undefined,
  };

  for (const [name, args, expected] of cases) {
    const tool = tools.get(name);
    assert.ok(tool?.renderCall, `${name} should render its call`);
    assert.ok(tool.renderResult, `${name} should render its result`);
    assert.equal(tool.renderShell, "self");
    assert.deepEqual(
      renderedLines(tool.renderCall(args as never, theme, context)),
      [expected],
    );
    assert.deepEqual(
      renderedLines(
        tool.renderResult(
          result,
          { expanded: false, isPartial: false },
          theme,
          context,
        ),
      ),
      [],
    );
  }

  const spawn = tools.get("subagent_spawn")!;
  const expanded = { expanded: true, isError: false } as never;
  assert.ok(
    renderedLines(
      spawn.renderCall!(cases[0]![1] as never, theme, expanded),
    ).some((line) => line.includes('"prompt"')),
  );
  assert.deepEqual(
    renderedLines(
      spawn.renderResult!(
        result,
        { expanded: true, isPartial: false },
        theme,
        expanded,
      ),
    ),
    ["Detailed tool result"],
  );

  const failed = { expanded: false, isError: true } as never;
  assert.ok(
    renderedLines(
      spawn.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme,
        failed,
      ),
    ).includes("Detailed tool result"),
  );
});

test("first-mate control messages collapse to concise headers", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
  } as Theme;

  const routineMessage = {
    role: "custom" as const,
    customType: "first-mate-control",
    content: `[First-mate control message fm-1]\nTask: task-1\nType: SCOPE_UPDATE\nSequence: 3\nPayload:\n{\n  \"message\": \"Narrow scope\"\n}`,
    display: true,
    timestamp: Date.now(),
    details: {
      id: "fm-1",
      taskId: "task-1",
      type: "SCOPE_UPDATE",
      sequence: 3,
      payload: { message: "Narrow scope" },
    },
  };
  const collapsedRoutine = renderFirstMateControlMessage(
    routineMessage,
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(collapsedRoutine);
  assert.deepEqual(renderedLines(collapsedRoutine), [
    "task-1 scope update · Narrow scope",
  ]);

  const expandedRoutineComponent = renderFirstMateControlMessage(
    routineMessage,
    { expanded: true, outputPad: 0 },
    theme,
  );
  assert.ok(expandedRoutineComponent);
  const expandedRoutine = renderedLines(expandedRoutineComponent);
  assert.ok(expandedRoutine.includes("[First-mate control message fm-1]"));
  assert.ok(expandedRoutine.includes("Payload:"));

  const outcomeMessage = {
    ...routineMessage,
    content: `[First-mate control message fm-2]\nTask: task-1\nType: TASK_COMPLETED\nSequence: 4\nPayload:\n{\n  \"summary\": \"Collapsed rendering updated\"\n}`,
    details: {
      ...routineMessage.details,
      id: "fm-2",
      type: "TASK_COMPLETED",
      sequence: 4,
      payload: { summary: "Collapsed rendering updated" },
    },
  };
  const collapsedOutcome = renderFirstMateControlMessage(
    outcomeMessage,
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(collapsedOutcome);
  assert.deepEqual(renderedLines(collapsedOutcome), [
    "task-1 task completed · Collapsed rendering updated",
  ]);
});

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

test("Herdr response fields are decoded through envelopes", () => {
  const response = {
    result: { agent: { pane_id: "w1:p2", state_change_seq: 42 } },
  };
  assert.equal(findString(response, ["pane_id"]), "w1:p2");
  assert.equal(findNumber(response, ["state_change_seq"]), 42);
});

test("background scripts expose a unique snapshot marker", () => {
  const script = buildBackgroundScript(
    "poll-deployment",
    "__DONE__",
    "__SNAPSHOT__",
  );
  assert.match(
    script,
    new RegExp(`export ${BACKGROUND_SNAPSHOT_VARIABLE}='__SNAPSHOT__'`),
  );
  assert.match(script, /poll-deployment/);
  assert.match(script, /__DONE__:%s/);
});

test("background completion selects the final marked snapshot", () => {
  const marker = "__SNAPSHOT__";
  const output = [
    marker,
    "ADMIN success",
    "GO in_progress",
    marker,
    "ADMIN success",
    "GO success",
  ].join("\n");
  assert.equal(
    extractFinalBackgroundSnapshot(output, marker),
    "ADMIN success\nGO success",
  );
  assert.equal(
    stripBackgroundSnapshotMarkers(output, marker),
    "ADMIN success\nGO in_progress\nADMIN success\nGO success",
  );
  assert.equal(extractFinalBackgroundSnapshot(output), undefined);
  assert.equal(
    extractFinalBackgroundSnapshot(output, "__MISSING__"),
    undefined,
  );
});

test("subagent prompts request a marked parent report without changing workflow protocol", () => {
  const subagentPrompt = buildChildPrompt({
    prompt: "Review the change",
    cwd: "/repo",
    kind: "subagent",
  });
  assert.match(subagentPrompt, new RegExp(PARENT_REPORT_START));
  assert.match(subagentPrompt, new RegExp(PARENT_REPORT_END));

  const workflowPrompt = buildChildPrompt({
    prompt: "Return structured JSON",
    cwd: "/repo",
    kind: "workflow-child",
  });
  assert.doesNotMatch(workflowPrompt, new RegExp(PARENT_REPORT_START));
  assert.match(
    workflowPrompt,
    /End with a concise report for the parent agent\./,
  );
});

test("parent report extraction omits child thinking and tool activity", () => {
  const transcript = [
    " Thinking...",
    " $ npm test",
    " lots of test output",
    PARENT_REPORT_START,
    "Implemented the fix. Tests pass.",
    PARENT_REPORT_END,
    "child prompt footer",
  ].join("\n");
  assert.equal(
    extractParentReport(transcript),
    "Implemented the fix. Tests pass.",
  );
});

test("parent report extraction falls back to the final visible response", () => {
  const transcript = [
    " Thinking...",
    " old tool activity",
    " Thinking...",
    "Concise legacy child report.",
  ].join("\n");
  assert.equal(extractParentReport(transcript), "Concise legacy child report.");
});

test("stale settled status cannot complete a newly prompted agent", () => {
  const stale = advanceAgentLifecycle(
    { status: "done", stateChangeSeq: 42 },
    42,
    false,
  );
  assert.deepEqual(stale, { activityObserved: false, settled: false });

  const working = advanceAgentLifecycle(
    { status: "working", stateChangeSeq: 42 },
    42,
    false,
  );
  assert.deepEqual(working, { activityObserved: true, settled: false });
  assert.deepEqual(
    advanceAgentLifecycle(
      { status: "done", stateChangeSeq: undefined },
      undefined,
      working.activityObserved,
    ),
    { activityObserved: true, settled: true },
  );

  const fastCompletion = advanceAgentLifecycle(
    { status: "done", stateChangeSeq: 43 },
    42,
    false,
  );
  assert.deepEqual(fastCompletion, {
    activityObserved: true,
    settled: true,
  });
});

test("Herdr prompt returns the lifecycle sequence used by monitoring", async () => {
  const runner: CliRunner = {
    async run(_command, args) {
      assert.deepEqual(args.slice(0, 2), ["agent", "prompt"]);
      return {
        stdout: JSON.stringify({
          result: { agent: { state_change_seq: 73 } },
        }),
        stderr: "",
        code: 0,
      };
    },
  };

  const prompted = await new HerdrClient(runner).promptAgent(
    "sa-review",
    "Review the change",
  );
  assert.deepEqual(prompted, { stateChangeSeq: 73 });
});

test("stable idle status is not prompt-ready until Herdr reports interactive readiness", async () => {
  let reads = 0;
  const runner: CliRunner = {
    async run(_command, args) {
      assert.deepEqual(args.slice(0, 2), ["agent", "get"]);
      reads += 1;
      return {
        stdout: agentResponse({
          status: "done",
          seq: 91,
          ready: reads >= 4,
        }),
        stderr: "",
        code: 0,
      };
    },
  };

  await new HerdrClient(runner, FAST_HERDR_TIMING).waitForAgentPromptReady(
    "sa-review",
    { paneId: "w1:p2", harness: "opencode" },
  );
  assert.ok(reads >= 5);
});

test("a prompt response without activity is retried and acknowledged", async () => {
  let prompts = 0;
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: agentResponse({ status: "idle", seq: 10 }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "prompt") {
        prompts += 1;
        assert.ok(args.includes("--wait"));
        assert.ok(args.includes("working"));
        assert.ok(args.includes("blocked"));
        return {
          stdout: agentResponse({
            status: prompts === 1 ? "idle" : "working",
            seq: prompts === 1 ? 10 : 11,
          }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  };

  const delivered = await new HerdrClient(
    runner,
    FAST_HERDR_TIMING,
  ).deliverInitialPrompt({
    name: "sa-review",
    harness: "opencode",
    paneId: "w1:p2",
    launchArgs: [],
    prompt: "Review the change",
  });

  assert.equal(prompts, 2);
  assert.deepEqual(delivered, {
    stateChangeSeq: 11,
    baselineStateChangeSeq: 10,
    attempts: 2,
  });
});

test("activity acknowledgement is harness-agnostic", async (t) => {
  for (const harness of ["pi", "claude", "codex", "opencode"] as const) {
    await t.test(harness, async () => {
      const runner: CliRunner = {
        async run(_command, args) {
          if (args[0] === "agent" && args[1] === "get")
            return {
              stdout: agentResponse({ status: "idle", seq: 15, harness }),
              stderr: "",
              code: 0,
            };
          if (args[0] === "agent" && args[1] === "prompt")
            return {
              stdout: agentResponse({ status: "working", seq: 16, harness }),
              stderr: "",
              code: 0,
            };
          throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
        },
      };

      await new HerdrClient(runner, FAST_HERDR_TIMING).deliverInitialPrompt({
        name: `sa-${harness}`,
        harness,
        paneId: "w1:p2",
        launchArgs: [],
        prompt: "Review the change",
      });
    });
  }
});

test("delivery retries after the harness becomes interactive", async () => {
  let prompts = 0;
  let readinessReads = 0;
  let ready = true;
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "agent" && args[1] === "get") {
        readinessReads += 1;
        if (!ready && readinessReads >= 7) ready = true;
        return {
          stdout: agentResponse({ status: "idle", seq: 20, ready }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        prompts += 1;
        if (prompts === 1) {
          ready = false;
          return {
            stdout: "",
            stderr: JSON.stringify({
              error: { code: "agent_not_ready", message: "replacing" },
            }),
            code: 1,
          };
        }
        return {
          stdout: agentResponse({ status: "working", seq: 21 }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  };

  await new HerdrClient(runner, FAST_HERDR_TIMING).deliverInitialPrompt({
    name: "sa-review",
    harness: "opencode",
    paneId: "w1:p2",
    launchArgs: [],
    prompt: "Review the change",
  });

  assert.equal(prompts, 2);
});

test("delayed activity acknowledges the first prompt without a duplicate", async () => {
  let prompts = 0;
  let postPromptReads = 0;
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "agent" && args[1] === "get") {
        if (prompts > 0) postPromptReads += 1;
        return {
          stdout: agentResponse({
            status: postPromptReads >= 2 ? "working" : "idle",
            seq: postPromptReads >= 2 ? 31 : 30,
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        prompts += 1;
        return {
          stdout: "",
          stderr: JSON.stringify({
            error: {
              code: "agent_prompt_stalled",
              message: "no lifecycle activity",
            },
          }),
          code: 1,
        };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  };

  const delivered = await new HerdrClient(
    runner,
    FAST_HERDR_TIMING,
  ).deliverInitialPrompt({
    name: "sa-review",
    harness: "opencode",
    paneId: "w1:p2",
    launchArgs: [],
    prompt: "Review the change",
  });

  assert.equal(prompts, 1);
  assert.equal(delivered.stateChangeSeq, 31);
});

test("permanent prompt failure has a bounded actionable error", async () => {
  let prompts = 0;
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: agentResponse({ status: "done", seq: 40 }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "prompt") {
        prompts += 1;
        return {
          stdout: agentResponse({ status: "done", seq: 40 }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  };

  await assert.rejects(
    new HerdrClient(runner, FAST_HERDR_TIMING).deliverInitialPrompt({
      name: "sa-review",
      harness: "opencode",
      paneId: "w1:p2",
      launchArgs: [],
      prompt: "Review the change",
    }),
    /Initial prompt delivery to opencode agent sa-review in pane w1:p2 was not acknowledged after 3 attempts/,
  );
  assert.equal(prompts, 3);
});

test("foreground replacement is rebound to the expected pane before retry", async () => {
  let prompts = 0;
  let starts = 0;
  let renames = 0;
  let replaced = false;
  let rebound = false;
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "agent" && args[1] === "get") {
        if (replaced && !rebound && args[2] === "sa-review")
          return {
            stdout: "",
            stderr: JSON.stringify({
              error: {
                code: "agent_not_ready",
                message: "no longer the pane foreground process",
              },
            }),
            code: 1,
          };
        return {
          stdout: agentResponse({
            status: "idle",
            seq: replaced ? 51 : 50,
            name: rebound ? "sa-review" : undefined,
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        prompts += 1;
        if (prompts === 1) {
          replaced = true;
          return {
            stdout: "",
            stderr: JSON.stringify({
              error: {
                code: "agent_not_ready",
                message: "no longer the pane foreground process",
              },
            }),
            code: 1,
          };
        }
        return {
          stdout: agentResponse({ status: "working", seq: 52 }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "agent" && args[1] === "rename") {
        renames += 1;
        rebound = true;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (args[0] === "agent" && args[1] === "start") {
        starts += 1;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  };

  await new HerdrClient(runner, FAST_HERDR_TIMING).deliverInitialPrompt({
    name: "sa-review",
    harness: "opencode",
    paneId: "w1:p2",
    launchArgs: ["--model", "test/model"],
    prompt: "Review the change",
  });

  assert.equal(starts, 0);
  assert.equal(renames, 1);
  assert.equal(prompts, 2);
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
            stderr: JSON.stringify({
              error: {
                code: starts === 1 ? "agent_not_ready" : "agent_pane_busy",
                message: "not ready",
              },
            }),
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

test("spawn records failed delivery without releasing its held Treehouse lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-delivery-fail-"));
  const registry = new TaskRegistry(join(directory, "registry.json"));
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CliRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === "git") return { stdout: "/repo\n", stderr: "", code: 0 };
      if (command === "treehouse" && args[0] === "get")
        return {
          stdout: JSON.stringify({ path: "/lease", lease_id: "lease-1" }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "current")
        return {
          stdout: JSON.stringify({
            result: {
              pane: {
                workspace_id: "w1",
                tab_id: "w1:t1",
                pane_id: "w1:p1",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
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
      if (args[0] === "agent" && args[1] === "start")
        return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: agentResponse({ status: "idle", seq: 60 }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "prompt")
        return {
          stdout: agentResponse({ status: "idle", seq: 60 }),
          stderr: "",
          code: 0,
        };
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    },
  };
  const manager = new OrchestrationManager(
    new HerdrClient(runner, FAST_HERDR_TIMING),
    new TreehouseClient(runner),
    registry,
    { onComplete() {} },
  );
  const previousHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    await assert.rejects(
      manager.spawnAgent({
        prompt: "Review the change",
        label: "delivery failure",
        harness: "opencode",
        cwd: "/repo",
        isolation: "treehouse",
        placement: "tab",
      }),
      /Initial prompt delivery.*was not acknowledged/,
    );
  } finally {
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
  }

  const [task] = await registry.list();
  assert.equal(task?.status, "failed");
  assert.match(task?.error ?? "", /was not acknowledged after 3 attempts/);
  assert.equal(task?.lease?.returnState, "held");
  assert.equal(
    calls.some(
      (call) => call.command === "treehouse" && call.args[0] === "return",
    ),
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
  const competingRegistry = new TaskRegistry(path);
  const attempts = await Promise.all([
    registry.transition("bg-1", ["running"], { status: "done" }),
    competingRegistry.transition("bg-1", ["running"], { status: "failed" }),
  ]);
  const winners = attempts.filter((task) => task !== undefined);
  assert.equal(winners.length, 1);
  assert.equal((await registry.get("bg-1"))?.status, winners[0]?.status);
  assert.match(await readFile(path, "utf8"), /"bg-1"/);

  await registry.update("bg-1", { resourceClosedAt: now - 10_000 });
  assert.equal(await registry.pruneClosedBefore(now - 5_000), 1);
  assert.equal(await registry.get("bg-1"), undefined);
});

test("all settled resources except blocked ones are eligible for auto-close", () => {
  assert.equal(isAutoCloseStatus("done"), true);
  assert.equal(isAutoCloseStatus("failed"), true);
  assert.equal(isAutoCloseStatus("cancelled"), true);
  assert.equal(isAutoCloseStatus("interrupted"), true);
  assert.equal(isAutoCloseStatus("timed-out"), true);
  assert.equal(isAutoCloseStatus("blocked"), false);
});

test("cancelling schedules prompt resource cleanup after Ctrl+C", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-cancel-"));
  const registry = new TaskRegistry(join(directory, "registry.json"));
  await registry.put({
    ...taskRecord("bg-running", "running"),
    kind: "background",
  });
  await registry.put({
    ...taskRecord("bg-settled", "done"),
    kind: "background",
  });
  const calls: Array<readonly string[]> = [];
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push(args);
      return { stdout: "{}", stderr: "", code: 0 };
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
    for (const id of ["bg-running", "bg-settled"]) {
      const before = Date.now();
      const task = await manager.cancel(id);
      const after = Date.now();
      assert.ok(task.autoCloseAt);
      assert.ok(task.autoCloseAt >= before + CANCEL_CLOSE_MS);
      assert.ok(task.autoCloseAt <= after + CANCEL_CLOSE_MS);
    }
    assert.equal((await registry.get("bg-running"))?.status, "cancelled");
    assert.equal((await registry.get("bg-settled"))?.status, "done");
    assert.equal(
      calls.filter(
        (args) =>
          args[0] === "pane" &&
          args[1] === "send-keys" &&
          args.includes("ctrl+c"),
      ).length,
      2,
    );
  } finally {
    manager.dispose();
    if (previousStateDirectory === undefined)
      delete process.env.PI_HERDR_STATE_DIR;
    else process.env.PI_HERDR_STATE_DIR = previousStateDirectory;
  }
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
  assert.equal(needsInspection({ ...task, resourceClosedAt: now }, now), false);
});

test("completed polling tasks deliver only the final snapshot and retain history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-snapshot-"));
  const registry = new TaskRegistry(join(directory, "registry.json"));
  const marker = "__SNAPSHOT__";
  await registry.put({
    ...taskRecord("bg-snapshot", "running"),
    kind: "background",
    sentinel: "__DONE__",
    snapshotMarker: marker,
  });
  const paneOutput = [
    marker,
    "ADMIN success",
    "GO in_progress",
    marker,
    "ADMIN success",
    "GO success",
    "__DONE__:0",
  ].join("\n");
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "pane" && args[1] === "read")
        return { stdout: paneOutput, stderr: "", code: 0 };
      if (args[0] === "notify") return { stdout: "{}", stderr: "", code: 0 };
      throw new Error(`unexpected call: ${args.join(" ")}`);
    },
  };
  const completions: string[] = [];
  const manager = new OrchestrationManager(
    new HerdrClient(runner),
    new TreehouseClient(runner),
    registry,
    { onComplete: (_task, output) => completions.push(output) },
  );
  const previousHerdrEnv = process.env.HERDR_ENV;
  const previousStateDirectory = process.env.PI_HERDR_STATE_DIR;
  process.env.HERDR_ENV = "1";
  process.env.PI_HERDR_STATE_DIR = directory;
  try {
    await manager.reconcile();
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await registry.get("bg-snapshot"))?.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(completions, ["ADMIN success\nGO success"]);
    assert.equal(
      await manager.output("bg-snapshot"),
      "ADMIN success\nGO in_progress\nADMIN success\nGO success",
    );
    assert.equal(
      await manager.report("bg-snapshot"),
      "ADMIN success\nGO success",
    );
    assert.equal((await registry.get("bg-snapshot"))?.exitCode, 0);
  } finally {
    manager.dispose();
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
    if (previousStateDirectory === undefined)
      delete process.env.PI_HERDR_STATE_DIR;
    else process.env.PI_HERDR_STATE_DIR = previousStateDirectory;
  }
});

test("a stale pane monitor cannot overwrite a captured background failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-settle-race-"));
  const registryPath = join(directory, "registry.json");
  const registry = new TaskRegistry(registryPath);
  const now = Date.now();
  await registry.put({
    id: "bg-race",
    label: "settlement race",
    kind: "background",
    parentSession: "owner-session",
    parentWorkspaceId: "w",
    parentTabId: "w:t1",
    parentPaneId: "w:p1",
    tabId: "w:t1",
    paneId: "w:p2",
    createdTab: false,
    createdPane: true,
    cwd: "/tmp",
    placement: "pane",
    status: "running",
    createdAt: now,
    updatedAt: now,
    sentinel: "__DONE__",
  });
  let paneReads = 0;
  let releaseReads!: () => void;
  const bothReading = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "pane" && args[1] === "read") {
        paneReads++;
        const readNumber = paneReads;
        if (paneReads === 2) releaseReads();
        await bothReading;
        if (readNumber === 1)
          return {
            stdout: "real command failure\n__DONE__:1\n",
            stderr: "",
            code: 0,
          };
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          stdout: "",
          stderr: '{"error":{"code":"pane_not_found"}}',
          code: 1,
        };
      }
      if (args[0] === "pane" && args[1] === "get")
        return { stdout: "", stderr: "pane not found", code: 1 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  };
  const completions: string[] = [];
  const createManager = () =>
    new OrchestrationManager(
      new HerdrClient(runner),
      new TreehouseClient(runner),
      new TaskRegistry(registryPath),
      { onComplete: (_task, output) => completions.push(output) },
    );
  const managers = [createManager(), createManager()];
  const previousHerdrEnv = process.env.HERDR_ENV;
  const previousStateDirectory = process.env.PI_HERDR_STATE_DIR;
  process.env.HERDR_ENV = "1";
  process.env.PI_HERDR_STATE_DIR = directory;
  try {
    await Promise.all(
      managers.map((manager) => manager.reconcile("owner-session")),
    );
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await registry.get("bg-race"))?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const task = await registry.get("bg-race");
    assert.equal(task?.status, "failed");
    assert.equal(completions.length, 1);
    assert.match(completions[0] ?? "", /real command failure/);
    assert.doesNotMatch(completions[0] ?? "", /pane_not_found/);
    const output = await readFile(task!.completionResultPath!, "utf8");
    assert.match(output, /real command failure/);
    assert.doesNotMatch(output, /pane_not_found/);
  } finally {
    for (const manager of managers) manager.dispose();
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
    if (previousStateDirectory === undefined)
      delete process.env.PI_HERDR_STATE_DIR;
    else process.env.PI_HERDR_STATE_DIR = previousStateDirectory;
  }
});

test("completed subagents deliver only their report and retain full activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-report-"));
  const registry = new TaskRegistry(join(directory, "registry.json"));
  await registry.put({
    ...taskRecord("sa-report", "running"),
    agentName: "sa-report-agent",
    promptStateChangeSeq: 1,
  });
  const transcript = [
    " Thinking...",
    " $ npm test",
    " verbose test activity",
    PARENT_REPORT_START,
    "Implemented the requested fix.",
    PARENT_REPORT_END,
  ].join("\n");
  const runner: CliRunner = {
    async run(_command, args) {
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: agentResponse({ status: "done", seq: 2 }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "read")
        return { stdout: transcript, stderr: "", code: 0 };
      if (args[0] === "notify") return { stdout: "{}", stderr: "", code: 0 };
      throw new Error(`unexpected call: ${args.join(" ")}`);
    },
  };
  const completions: string[] = [];
  const manager = new OrchestrationManager(
    new HerdrClient(runner),
    new TreehouseClient(runner),
    registry,
    { onComplete: (_task, output) => completions.push(output) },
  );
  const previousHerdrEnv = process.env.HERDR_ENV;
  const previousStateDirectory = process.env.PI_HERDR_STATE_DIR;
  process.env.HERDR_ENV = "1";
  process.env.PI_HERDR_STATE_DIR = directory;
  try {
    await manager.reconcile();
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await registry.get("sa-report"))?.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const task = await registry.get("sa-report");
    assert.equal(task?.status, "done");
    assert.deepEqual(completions, ["Implemented the requested fix."]);
    assert.equal(await manager.report("sa-report"), completions[0]);
    assert.equal(await manager.output("sa-report"), transcript);
    assert.equal(
      await readFile(task!.completionResultPath!, "utf8"),
      transcript,
    );
  } finally {
    manager.dispose();
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
    if (previousStateDirectory === undefined)
      delete process.env.PI_HERDR_STATE_DIR;
    else process.env.PI_HERDR_STATE_DIR = previousStateDirectory;
  }
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
    completionReport: "concise child report",
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
    assert.equal(await manager.report("sa-done"), "concise child report");
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
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await registry.get("bg-failed"))?.resourceClosedAt !== undefined)
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    manager.dispose();
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
