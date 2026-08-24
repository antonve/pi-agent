import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { CliRunner } from "./cli.ts";
import {
  buildManagedLinearPlanCommentMarker,
  buildSecondMatePrompt,
  FleetManager,
  parseLinearIssueReference,
} from "./fleet-manager.ts";
import { FleetStore } from "./fleet.ts";
import {
  buildHeadlessScript,
  hasHeadlessActivity,
  parseLeafOutcome,
  type HeadlessRunArtifacts,
} from "./headless-runner.ts";
import {
  buildHeadlessHarnessLaunch,
  extractHarnessSessionId,
  type HeadlessHarnessLaunch,
} from "./harnesses.ts";
import { HerdrClient } from "./herdr-client.ts";
import { OrchestrationManager } from "./manager.ts";
import {
  parseCompiledFleetReport,
  shouldCompileReports,
} from "./report-compiler.ts";
import { TaskRegistry } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";

const execFileAsync = promisify(execFile);

function artifacts(): HeadlessRunArtifacts {
  return {
    directory: "/state/run",
    promptPath: "/state/run/prompt.txt",
    outputPath: "/state/run/output.jsonl",
    exitStatusPath: "/state/run/exit-status",
    lastMessagePath: "/state/run/last-message.txt",
    pidPath: "/state/run/pid",
    scriptPath: "/state/run/run.mjs",
  };
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

test("all leaf harnesses use explicit headless subcommands", () => {
  const pi = buildHeadlessHarnessLaunch({
    harness: "pi",
    resultPath: "/tmp/result",
    sessionId: "pi-session",
  });
  assert.deepEqual(pi.args.slice(0, 3), ["--mode", "json", "--approve"]);
  assert.equal(pi.promptDelivery, "stdin");
  assert.ok(pi.args.includes("--exclude-tools"));
  assert.ok(pi.args.includes("--no-extensions"));
  assert.ok(pi.args.some((argument) => argument.includes("bg_start")));

  const claude = buildHeadlessHarnessLaunch({
    harness: "claude",
    resultPath: "/tmp/result",
  });
  assert.ok(claude.args.includes("--print"));
  assert.ok(claude.args.includes("stream-json"));
  assert.equal(claude.promptDelivery, "stdin");
  assert.ok(claude.args.includes("--disallowedTools"));
  assert.ok(claude.args.includes("Task"));

  const codex = buildHeadlessHarnessLaunch({
    harness: "codex",
    resultPath: "/tmp/result",
  });
  assert.ok(codex.args.includes("exec"));
  assert.ok(codex.args.includes("--json"));
  assert.equal(codex.args.at(-1), "-");
  assert.ok(codex.args.includes("features.multi_agent=false"));

  const opencode = buildHeadlessHarnessLaunch({
    harness: "opencode",
    resultPath: "/tmp/result",
  });
  assert.equal(opencode.args[0], "run");
  assert.ok(opencode.args.includes("--pure"));
  assert.ok(opencode.args.includes("--format"));
  assert.equal(opencode.promptDelivery, "argument");
});

test("headless scripts submit prompts during process startup", () => {
  const launch = buildHeadlessHarnessLaunch({
    harness: "claude",
    resultPath: "/state/run/last-message.txt",
  });
  const script = buildHeadlessScript(launch, artifacts());
  assert.match(script, /spawn\(command, args/);
  assert.match(script, /shell: false/);
  assert.match(script, /child\.stdin\.end\(prompt\)/);
  assert.match(script, /output\.jsonl/);
  assert.match(script, /PI_FIRST_MATE_ROLE: "leaf"/);
  assert.match(script, /guard-bin/);
  assert.doesNotMatch(script, /herdr agent prompt|send-text|send-keys/);

  const opencode = buildHeadlessHarnessLaunch({
    harness: "opencode",
    resultPath: "/state/run/last-message.txt",
  });
  assert.match(
    buildHeadlessScript(opencode, artifacts()),
    /OPENCODE_PERMISSION:.*task.*deny/,
  );
});

test("headless wrapper spawns without a shell and supplies prompt on stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-leaf-wrapper-"));
  const run: HeadlessRunArtifacts = {
    directory,
    promptPath: join(directory, "prompt.txt"),
    outputPath: join(directory, "output.jsonl"),
    exitStatusPath: join(directory, "exit-status"),
    lastMessagePath: join(directory, "last-message.txt"),
    pidPath: join(directory, "pid"),
    scriptPath: join(directory, "run.mjs"),
  };
  const prompt = "prompt with 'quotes' and $(shell syntax)";
  await writeFile(run.promptPath, prompt);
  const launch: HeadlessHarnessLaunch = {
    kind: "pi",
    command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    promptDelivery: "stdin",
  };
  await writeFile(run.scriptPath, buildHeadlessScript(launch, run));
  await execFileAsync(process.execPath, [run.scriptPath], { cwd: directory });
  assert.equal(await readFile(run.outputPath, "utf8"), prompt);
  assert.equal((await readFile(run.exitStatusPath, "utf8")).trim(), "0");
});

test("headless startup requires prompt-acceptance activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-leaf-activity-"));
  const run = {
    ...artifacts(),
    directory,
    outputPath: join(directory, "output.jsonl"),
  };
  await writeFile(
    run.outputPath,
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  );
  assert.equal(await hasHeadlessActivity(run, "codex"), false);
  await writeFile(
    run.outputPath,
    `${JSON.stringify({ type: "thread.started" })}\n${JSON.stringify({ type: "turn.started" })}\n`,
  );
  assert.equal(await hasHeadlessActivity(run, "codex"), true);
});

test("leaf reports distinguish questions and capture harness sessions", () => {
  const report = {
    status: "question",
    summary: "Need a compatibility decision",
    changes: [],
    verification: [],
    risks: [],
    question: "Preserve legacy behavior?",
    options: ["yes", "no"],
    recommendation: "no",
    artifacts: [],
  };
  const assistant = `PI_PARENT_REPORT_BEGIN\n${JSON.stringify(report)}\nPI_PARENT_REPORT_END`;
  const output = [
    JSON.stringify({ type: "session", id: "pi-session" }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistant }],
      },
    }),
  ].join("\n");
  const outcome = parseLeafOutcome({
    harness: "pi",
    output,
    exitCode: 0,
    fallbackSessionId: "pi-session",
  });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.sessionId, "pi-session");
  assert.equal(JSON.parse(outcome.report).status, "question");

  assert.equal(
    extractHarnessSessionId(
      "codex",
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    ),
    "thread-1",
  );
});

test("Linear issue references are parsed from identifiers and URLs", () => {
  assert.equal(parseLinearIssueReference("ENG-123"), "ENG-123");
  assert.equal(
    parseLinearIssueReference(
      "https://linear.app/acme/issue/ENG-123/keep-linear-sync-working",
    ),
    "ENG-123",
  );
  assert.equal(parseLinearIssueReference("not a Linear reference"), undefined);
});

test("second-mate prompts make Linear synchronization explicit", () => {
  const marker = buildManagedLinearPlanCommentMarker({
    id: "pi-agent-linear-sync",
    linearIssue: "ENG-123",
  });
  const prompt = buildSecondMatePrompt({
    id: "pi-agent-linear-sync",
    title: "Keep Linear tickets synchronized",
    brief: "Update the orchestration config.",
    linearIssue: "ENG-123",
    cwd: "/repo",
    state: "assigned",
    ownerSessionId: "first-mate-session",
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    nextSequence: 1,
  });
  assert.match(prompt, /Before planning, read the issue with linear_get_issue/);
  assert.match(prompt, /move the issue to the team’s started workflow state/);
  assert.match(
    prompt,
    new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(prompt, /use linear_graphql to edit that same comment/);
  assert.match(
    prompt,
    /Move the issue to completed only after verified success/,
  );
});

test("second-mate prompts require verification, plan ownership, and review-ready PR delivery", () => {
  const prompt = buildSecondMatePrompt({
    id: "TASK-1",
    title: "Example",
    brief: "Implement the example",
    cwd: "/repo",
    state: "assigned",
    ownerSessionId: "captain-session",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    nextSequence: 1,
  });
  assert.match(
    prompt,
    /creating and updating any `~\/xdev\/plans` file needed for this task/i,
  );
  assert.match(
    prompt,
    /preserve the implementation context needed for follow-through/i,
  );
  assert.match(
    prompt,
    /keep the task active or resume it rather than terminally completing it/i,
  );
  assert.match(prompt, /verify the change, commit it, push it/i);
  assert.match(
    prompt,
    /review-ready PR unless explicitly told to stay local-only/i,
  );
  assert.match(prompt, /include the PR URL in complete_task/i);
  assert.match(prompt, /retain the Treehouse lease for review follow-up/i);
  assert.match(
    prompt,
    /Call complete_task or fail_task exactly once when the task truly reaches a terminal outcome/i,
  );
});

test("fleet messages are sequenced, replayed, and acknowledged durably", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-first-mate-"));
  const store = new FleetStore(join(directory, "fleet.json"));
  await store.createTask({
    id: "TASK-1",
    title: "Example",
    brief: "Do the work",
    cwd: "/repo",
    state: "assigned",
    ownerSessionId: "captain-session",
    mateSessionId: "mate-session",
  });
  const first = await store.enqueue({
    taskId: "TASK-1",
    type: "SCOPE_UPDATE",
    fromSessionId: "captain-session",
    toTaskMate: true,
    payload: { message: "Keep the change focused" },
  });
  const second = await store.enqueue({
    taskId: "TASK-1",
    type: "DECISION_RESPONSE",
    fromSessionId: "captain-session",
    toSessionId: "mate-session",
    payload: { message: "Choose the current API" },
  });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(
    (await store.pendingFor("mate-session", "TASK-1")).map(
      (message) => message.id,
    ),
    [first.id, second.id],
  );
  await store.acknowledge(first.id, "mate-session");
  assert.deepEqual(
    (await store.pendingFor("mate-session", "TASK-1")).map(
      (message) => message.id,
    ),
    [second.id],
  );
  const duplicate = await store.acknowledge(first.id, "mate-session");
  assert.equal(duplicate.acknowledgedBy, "mate-session");
  await writeFile(store.path, "{invalid");
  await assert.rejects(
    () => store.listTasks(),
    /Invalid first-mate fleet store/,
  );
});

test("task assignment creates one Space with the second mate in its root tab", async () => {
  await withHerdrSocket(async (requests) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fleet-assignment-"));
    const calls: string[][] = [];
    let ownerAlive = true;
    const runner: CliRunner = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === "workspace" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: args[2], focused: true },
              },
            }),
          };
        if (args[0] === "workspace" && args[1] === "create")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: "w-task" },
                tab: { tab_id: "w-task:t1" },
                root_pane: { pane_id: "w-task:p1" },
              },
            }),
          };
        if (
          args[0] === "agent" &&
          args[1] === "get" &&
          args[2] === "w-owner:p1" &&
          !ownerAlive
        )
          return {
            code: 1,
            stderr: "",
            stdout: JSON.stringify({
              error: {
                code: "agent_not_found",
                message: "agent target w-owner:p1 not found",
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task:p1",
                agent_status: "idle",
                agent: "pi",
                name: "mate-task-1",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
                agent_session: { value: "mate-session" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "prompt")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task:p1",
                agent_status: "working",
                agent: "pi",
                name: "mate-task-1",
                state_change_seq: 2,
                interactive_ready: true,
                launch_pending: false,
              },
            }),
          };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      },
    };
    const herdr = new HerdrClient(runner, {
      promptReadyPollMs: 1,
      promptReadyConsecutiveReads: 1,
    });
    const orchestration = new OrchestrationManager(
      herdr,
      new TreehouseClient(runner),
      new TaskRegistry(join(directory, "registry.json")),
      { onComplete() {} },
    );
    await assert.rejects(
      () =>
        orchestration.startBackground({
          command: "server",
          label: "server",
          cwd: "/repo",
          placement: "tab",
          jobKind: "service",
        }),
      /require a readiness pattern/,
    );
    const store = new FleetStore(join(directory, "fleet.json"));
    const fleet = new FleetManager(store, herdr, orchestration);
    await assert.rejects(
      () => fleet.requireFirstMate("first-mate-session"),
      /no first mate/,
    );
    await fleet.claimFirstMate({
      sessionId: "first-mate-session",
      workspaceId: "w-owner",
      tabId: "w-owner:t1",
      paneId: "w-owner:p1",
      cwd: "/repo",
    });
    await assert.rejects(
      () => fleet.requireFirstMate("other-session"),
      /owned by session first-mate-session/,
    );
    const task = await fleet.assignTask({
      id: "TASK-1",
      title: "Example task",
      brief: "Implement the example",
      cwd: "/repo",
      ownerSessionId: "first-mate-session",
    });
    assert.equal(task.state, "assigned");
    assert.equal(task.workspaceId, "w-task");
    assert.equal(task.mateTabId, "w-task:t1");
    assert.deepEqual(
      calls
        .find((args) => args[0] === "workspace" && args[1] === "create")
        ?.slice(0, 6),
      [
        "workspace",
        "create",
        "--cwd",
        "/repo",
        "--label",
        "TASK-1 Example task",
      ],
    );
    assert.equal(
      calls.some((args) => args[0] === "tab" && args[1] === "create"),
      false,
    );
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[2] === "w-task:t1" &&
          args[3] === "secondmate",
      ),
      true,
    );
    assert.equal(
      (await store.messagesForTask(task.id))[0]?.type,
      "TASK_ASSIGNED",
    );
    await fleet.registerMate({
      taskId: task.id,
      sessionId: "mate-session",
      workspaceId: "w-task",
      tabId: "w-task:t1",
      paneId: "w-task:p1",
    });
    await fleet.sendToFirstMate({
      taskId: task.id,
      type: "DECISION_REQUEST",
      fromSessionId: "mate-session",
      payload: { question: "Use the current API?" },
    });
    assert.equal((await store.getTask(task.id))?.state, "waiting-decision");
    await fleet.sendToMate({
      taskId: task.id,
      type: "DECISION_RESPONSE",
      fromSessionId: "first-mate-session",
      payload: { answer: "yes" },
    });
    await fleet.sendToFirstMate({
      taskId: task.id,
      type: "TASK_COMPLETED",
      fromSessionId: "mate-session",
      payload: { summary: "Verified" },
    });
    assert.equal((await store.getTask(task.id))?.state, "completed");
    const completion = (await store.messagesForTask(task.id)).find(
      (message) => message.type === "TASK_COMPLETED",
    );
    assert.ok(completion);
    await store.acknowledge(completion.id, "first-mate-session");
    await assert.rejects(
      () =>
        fleet.claimFirstMate({
          sessionId: "replacement-session",
          workspaceId: "w-replacement",
          tabId: "w-replacement:t1",
          paneId: "w-replacement:p1",
          cwd: "/repo",
        }),
      /already owned by live session/,
    );
    ownerAlive = false;
    await assert.rejects(
      () =>
        fleet.claimFirstMate({
          sessionId: "replacement-session",
          workspaceId: "w-replacement",
          tabId: "w-replacement:t1",
          paneId: "w-replacement:p1",
          cwd: "/repo",
        }),
      /already owned by live session/,
    );
    const staleState = JSON.parse(await readFile(store.path, "utf8")) as {
      firstMate: { updatedAt: number };
    };
    staleState.firstMate.updatedAt = 0;
    await writeFile(store.path, `${JSON.stringify(staleState, null, 2)}\n`);
    await fleet.claimFirstMate({
      sessionId: "replacement-session",
      workspaceId: "w-replacement",
      tabId: "w-replacement:t1",
      paneId: "w-replacement:p1",
      cwd: "/repo",
    });
    assert.equal(
      (await store.getTask(task.id))?.ownerSessionId,
      "replacement-session",
    );
    assert.ok(
      (await store.pendingFor("replacement-session")).some(
        (message) => message.type === "TASK_COMPLETED",
      ),
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
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[2] === "w-replacement:t1" &&
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
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "workspace" &&
          args[1] === "report-metadata" &&
          args[2] === "w-task" &&
          args.includes("repo=repo"),
      ),
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "workspace.move")
        .map((request) => request.params),
      [
        { workspace_id: "w-owner", insert_index: 0 },
        { workspace_id: "w-replacement", insert_index: 0 },
      ],
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "pane.focus")
        .map((request) => request.params),
      [
        { pane_id: "w-owner:p1" },
        { pane_id: "w-owner:p1" },
        { pane_id: "w-replacement:p1" },
      ],
    );
  });
});

test("task assignment does not steal focus when the first-mate workspace is not focused", async () => {
  await withHerdrSocket(async (requests) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fleet-no-focus-"));
    const calls: string[][] = [];
    const runner: CliRunner = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === "workspace" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: args[2], focused: false },
              },
            }),
          };
        if (args[0] === "workspace" && args[1] === "create")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: "w-task" },
                tab: { tab_id: "w-task:t1" },
                root_pane: { pane_id: "w-task:p1" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task:p1",
                agent_status: "idle",
                agent: "pi",
                name: "mate-task-1",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
                agent_session: { value: "mate-session" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "prompt")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task:p1",
                agent_status: "working",
                agent: "pi",
                name: "mate-task-1",
                state_change_seq: 2,
                interactive_ready: true,
                launch_pending: false,
              },
            }),
          };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      },
    };
    const herdr = new HerdrClient(runner, {
      promptReadyPollMs: 1,
      promptReadyConsecutiveReads: 1,
    });
    const fleet = new FleetManager(
      new FleetStore(join(directory, "fleet.json")),
      herdr,
      new OrchestrationManager(
        herdr,
        new TreehouseClient(runner),
        new TaskRegistry(join(directory, "registry.json")),
        { onComplete() {} },
      ),
    );
    await fleet.claimFirstMate({
      sessionId: "first-mate-session",
      workspaceId: "w-owner",
      tabId: "w-owner:t1",
      paneId: "w-owner:p1",
      cwd: "/repo",
    });
    requests.length = 0;
    await fleet.assignTask({
      id: "ENG-123",
      title: "Keep Linear tickets synchronized",
      brief: "Implement the sync flow.",
      cwd: "/repo",
      ownerSessionId: "first-mate-session",
    });
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[2] === "w-task:t1" &&
          args[3] === "secondmate",
      ),
      true,
    );
    assert.deepEqual(
      requests.filter((request) => request.method === "pane.focus"),
      [],
    );
  });
});

test("task assignment failure closes the workspace and restores first-mate focus", async () => {
  await withHerdrSocket(async (requests) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fleet-close-focus-"));
    const calls: string[][] = [];
    const runner: CliRunner = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === "workspace" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: args[2], focused: true },
              },
            }),
          };
        if (args[0] === "workspace" && args[1] === "create")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: "w-task" },
                tab: { tab_id: "w-task:t1" },
                root_pane: { pane_id: "w-task:p1" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task:p1",
                agent_status: "idle",
                agent: "pi",
                name: "mate-task-1",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
                agent_session: { value: "mate-session" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "prompt")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task:p1",
                agent_status: "idle",
                agent: "pi",
                name: "mate-task-1",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
              },
            }),
          };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      },
    };
    const herdr = new HerdrClient(runner, {
      promptReadyPollMs: 1,
      promptReadyConsecutiveReads: 1,
      promptDeliveryAttempts: 2,
      promptActivityTimeoutMs: 5,
      promptLateActivityMs: 5,
    });
    const fleet = new FleetManager(
      new FleetStore(join(directory, "fleet.json")),
      herdr,
      new OrchestrationManager(
        herdr,
        new TreehouseClient(runner),
        new TaskRegistry(join(directory, "registry.json")),
        { onComplete() {} },
      ),
    );
    await fleet.claimFirstMate({
      sessionId: "first-mate-session",
      workspaceId: "w-owner",
      tabId: "w-owner:t1",
      paneId: "w-owner:p1",
      cwd: "/repo",
    });
    requests.length = 0;
    await assert.rejects(
      () =>
        fleet.assignTask({
          id: "TASK-FAIL",
          title: "Example task",
          brief: "Implement the example",
          cwd: "/repo",
          ownerSessionId: "first-mate-session",
        }),
      /Initial prompt delivery/,
    );
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "workspace" &&
          args[1] === "close" &&
          args[2] === "w-task",
      ),
      true,
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "pane.focus")
        .map((request) => request.params),
      [{ pane_id: "w-owner:p1" }],
    );
  });
});

test("task assignment propagates Linear sync metadata into the second-mate prompt", async () => {
  await withHerdrSocket(async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fleet-linear-sync-"));
    const calls: string[][] = [];
    const runner: CliRunner = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === "workspace" && args[1] === "create")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: "w-linear" },
                tab: { tab_id: "w-linear:t1" },
                root_pane: { pane_id: "w-linear:p1" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-linear:p1",
                agent_status: "idle",
                agent: "pi",
                name: "mate-task-linear",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
                agent_session: { value: "mate-session" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "prompt")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-linear:p1",
                agent_status: "working",
                agent: "pi",
                name: "mate-task-linear",
                state_change_seq: 2,
                interactive_ready: true,
                launch_pending: false,
              },
            }),
          };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      },
    };
    const herdr = new HerdrClient(runner, {
      promptReadyPollMs: 1,
      promptReadyConsecutiveReads: 1,
    });
    const fleet = new FleetManager(
      new FleetStore(join(directory, "fleet.json")),
      herdr,
      new OrchestrationManager(
        herdr,
        new TreehouseClient(runner),
        new TaskRegistry(join(directory, "registry.json")),
        { onComplete() {} },
      ),
    );
    await fleet.claimFirstMate({
      sessionId: "first-mate-session",
      workspaceId: "w-owner",
      tabId: "w-owner:t1",
      paneId: "w-owner:p1",
      cwd: "/repo",
    });
    const task = await fleet.assignTask({
      id: "task-linear",
      title: "Keep Linear tickets synchronized",
      brief: "Implement the sync flow for ENG-123.",
      linearIssue:
        "https://linear.app/acme/issue/ENG-123/keep-linear-tickets-synchronized",
      cwd: "/repo",
      ownerSessionId: "first-mate-session",
    });
    assert.equal(task.linearIssue, "ENG-123");
    assert.deepEqual(
      calls
        .find((args) => args[0] === "workspace" && args[1] === "create")
        ?.slice(0, 6),
      [
        "workspace",
        "create",
        "--cwd",
        "/repo",
        "--label",
        "ENG-123 Keep Linear tickets synchronized",
      ],
    );
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[2] === "w-linear:t1" &&
          args[3] === "secondmate",
      ),
      true,
    );
    const assignment = (await fleet.store.messagesForTask(task.id))[0];
    assert.equal(assignment?.payload.linearIssue, "ENG-123");
    const promptCall = calls.find(
      (args) => args[0] === "agent" && args[1] === "prompt",
    );
    assert.ok(promptCall);
    assert.match(promptCall[3]!, /Linear synchronization:/);
    assert.match(
      promptCall[3]!,
      /<!-- pi-linear-sync task=task-linear issue=ENG-123 -->/,
    );
  });
});

test("workspace labels use the canonical Linear identifier resolved from the brief", async () => {
  await withHerdrSocket(async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fleet-linear-brief-"));
    const calls: string[][] = [];
    const runner: CliRunner = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === "workspace" && args[1] === "create")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: "w-brief" },
                tab: { tab_id: "w-brief:t1" },
                root_pane: { pane_id: "w-brief:p1" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-brief:p1",
                agent_status: "idle",
                agent: "pi",
                name: "mate-task-brief",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
                agent_session: { value: "mate-session" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "prompt")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-brief:p1",
                agent_status: "working",
                agent: "pi",
                name: "mate-task-brief",
                state_change_seq: 2,
                interactive_ready: true,
                launch_pending: false,
              },
            }),
          };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      },
    };
    const herdr = new HerdrClient(runner, {
      promptReadyPollMs: 1,
      promptReadyConsecutiveReads: 1,
    });
    const fleet = new FleetManager(
      new FleetStore(join(directory, "fleet.json")),
      herdr,
      new OrchestrationManager(
        herdr,
        new TreehouseClient(runner),
        new TaskRegistry(join(directory, "registry.json")),
        { onComplete() {} },
      ),
    );
    await fleet.claimFirstMate({
      sessionId: "first-mate-session",
      workspaceId: "w-owner",
      tabId: "w-owner:t1",
      paneId: "w-owner:p1",
      cwd: "/repo",
    });
    const task = await fleet.assignTask({
      id: "task-brief",
      title: "Implement the sync flow",
      brief: "Handle follow-up work for ENG-456.",
      cwd: "/repo",
      ownerSessionId: "first-mate-session",
    });
    assert.equal(task.linearIssue, "ENG-456");
    assert.deepEqual(
      calls
        .find((args) => args[0] === "workspace" && args[1] === "create")
        ?.slice(0, 6),
      [
        "workspace",
        "create",
        "--cwd",
        "/repo",
        "--label",
        "ENG-456 Implement the sync flow",
      ],
    );
  });
});

test("workspace labels use the canonical Linear identifier resolved from task_id", async () => {
  await withHerdrSocket(async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fleet-linear-task-id-"));
    const calls: string[][] = [];
    const runner: CliRunner = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === "workspace" && args[1] === "create")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                workspace: { workspace_id: "w-task-id" },
                tab: { tab_id: "w-task-id:t1" },
                root_pane: { pane_id: "w-task-id:p1" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task-id:p1",
                agent_status: "idle",
                agent: "pi",
                name: "mate-task-id",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
                agent_session: { value: "mate-session" },
              },
            }),
          };
        if (args[0] === "agent" && args[1] === "prompt")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                pane_id: "w-task-id:p1",
                agent_status: "working",
                agent: "pi",
                name: "mate-task-id",
                state_change_seq: 2,
                interactive_ready: true,
                launch_pending: false,
              },
            }),
          };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      },
    };
    const herdr = new HerdrClient(runner, {
      promptReadyPollMs: 1,
      promptReadyConsecutiveReads: 1,
    });
    const fleet = new FleetManager(
      new FleetStore(join(directory, "fleet.json")),
      herdr,
      new OrchestrationManager(
        herdr,
        new TreehouseClient(runner),
        new TaskRegistry(join(directory, "registry.json")),
        { onComplete() {} },
      ),
    );
    await fleet.claimFirstMate({
      sessionId: "first-mate-session",
      workspaceId: "w-owner",
      tabId: "w-owner:t1",
      paneId: "w-owner:p1",
      cwd: "/repo",
    });
    const task = await fleet.assignTask({
      id: "ENG-789",
      title: "Implement the sync flow",
      brief: "Handle follow-up work.",
      cwd: "/repo",
      ownerSessionId: "first-mate-session",
    });
    assert.equal(task.linearIssue, "ENG-789");
    assert.deepEqual(
      calls
        .find((args) => args[0] === "workspace" && args[1] === "create")
        ?.slice(0, 6),
      [
        "workspace",
        "create",
        "--cwd",
        "/repo",
        "--label",
        "ENG-789 Implement the sync flow",
      ],
    );
  });
});

test("manager starts leaves through the headless tab path without agent UI commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headless-manager-"));
  const previousState = process.env.PI_HERDR_STATE_DIR;
  const previousHerdr = process.env.HERDR_ENV;
  process.env.PI_HERDR_STATE_DIR = directory;
  process.env.HERDR_ENV = "1";
  const calls: string[][] = [];
  let turns = 0;
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "current")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              workspace_id: "w1",
              tab_id: "w1:t1",
              pane_id: "w1:p1",
            },
          }),
        };
      if (args[0] === "tab" && args[1] === "create")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: { tab_id: "w1:t2", pane_id: "w1:p2" },
          }),
        };
      if (args[0] === "pane" && args[1] === "run") {
        turns += 1;
        const script = args[3]!.match(/'([^']+\/run\.mjs)'$/)?.[1];
        assert.ok(script);
        const runDirectory = join(script, "..");
        const report = `PI_PARENT_REPORT_BEGIN\n${JSON.stringify(
          turns === 1
            ? { status: "question", summary: "Need a decision" }
            : { status: "done", summary: "ok" },
        )}\nPI_PARENT_REPORT_END`;
        await writeFile(
          join(runDirectory, "output.jsonl"),
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: report }] } })}\n`,
        );
        await writeFile(join(runDirectory, "exit-status"), "0\n");
        return { code: 0, stderr: "", stdout: "{}" };
      }
      if (args[0] === "pane" && args[1] === "get")
        return { code: 0, stderr: "", stdout: "{}" };
      if (args[0] === "notification")
        return { code: 0, stderr: "", stdout: "{}" };
      return { code: 0, stderr: "", stdout: "{}" };
    },
  };
  try {
    const manager = new OrchestrationManager(
      new HerdrClient(runner),
      new TreehouseClient(runner),
      new TaskRegistry(join(directory, "registry.json")),
      { onComplete() {} },
    );
    const task = await manager.spawnLeaf({
      prompt: "Review the change",
      label: "review",
      harness: "pi",
      cwd: "/repo",
      isolation: "shared",
      placement: "tab",
    });
    const [question] = await manager.wait([task.id]);
    assert.equal(question?.status, "blocked");
    const resumed = await manager.send(task.id, "Use the current API.");
    assert.equal(resumed.status, "running");
    const [settled] = await manager.wait([task.id]);
    assert.equal(settled?.status, "done");
    assert.equal(settled?.turn, 2);
    assert.equal(settled?.executionMode, "headless");
    assert.equal(
      calls.filter((args) => args[0] === "tab" && args[1] === "create").length,
      1,
      "resumed turns must reuse the logical leaf tab",
    );
    assert.equal(
      calls.some((args) => args[0] === "agent"),
      false,
      "leaf launch must not call Herdr's interactive agent surface",
    );
    manager.dispose();
  } finally {
    if (previousState === undefined) delete process.env.PI_HERDR_STATE_DIR;
    else process.env.PI_HERDR_STATE_DIR = previousState;
    if (previousHerdr === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdr;
  }
});

test("Luna compilation is skipped for concise single reports and validates boundaries", () => {
  assert.equal(shouldCompileReports(["concise"]), false);
  assert.equal(shouldCompileReports(["one", "two"]), true);
  assert.deepEqual(
    parseCompiledFleetReport(
      JSON.stringify({
        summary: "Complete",
        changes: ["Changed the adapter"],
        verification: ["Tests pass"],
        risks: [],
        decisions: [],
        artifacts: ["result.json"],
      }),
    ),
    {
      summary: "Complete",
      changes: ["Changed the adapter"],
      verification: ["Tests pass"],
      risks: [],
      decisions: [],
      artifacts: ["result.json"],
    },
  );
});

test("Herdr task workspaces and sidebar metadata use workspace APIs", async () => {
  const calls: string[][] = [];
  const runner: CliRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args[0] === "workspace" && args[1] === "create")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              workspace: { workspace_id: "w9" },
              tab: { tab_id: "w9:t1" },
              root_pane: { pane_id: "w9:p1" },
            },
          }),
        };
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  };
  const herdr = new HerdrClient(runner);
  const workspace = await herdr.createTaskWorkspace("/repo", "TASK-1 example", {
    PI_FIRST_MATE_TASK_ID: "TASK-1",
  });
  assert.deepEqual(workspace, {
    workspaceId: "w9",
    tabId: "w9:t1",
    paneId: "w9:p1",
  });
  await herdr.reportWorkspaceMetadata("w9", "pi-first-mate", {
    task_status: "active",
    worker_summary: "2 active",
  });
  assert.ok(calls[0]!.includes("PI_FIRST_MATE_TASK_ID=TASK-1"));
  assert.deepEqual(calls[1]!.slice(0, 4), [
    "workspace",
    "report-metadata",
    "w9",
    "--source",
  ]);
});
