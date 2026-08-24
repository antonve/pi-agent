import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  formatSize,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import {
  AUTO_CLOSE_MS,
  isAutoCloseStatus,
  UNKNOWN_AGENT_GRACE_MS,
} from "./domain.ts";
import type {
  CreatedResource,
  Placement,
  SpawnAgentOptions,
  TaskRecord,
} from "./domain.ts";
import { buildHarnessLaunch } from "./harnesses.ts";
import {
  hasHeadlessActivity,
  HEADLESS_STARTUP_TIMEOUT_MS,
  parseLeafOutcome,
  prepareHeadlessRun,
  readHeadlessExit,
  readHeadlessOutput,
  type HeadlessRunArtifacts,
} from "./headless-runner.ts";
import { HerdrClient, type HerdrAgent } from "./herdr-client.ts";
import { resolveIsolation, resolvePlacement } from "./placement.ts";
import { TaskRegistry, stateDirectory } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";
import {
  resolveWorkerPolicy,
  REVIEW_SCOPE_GUARD,
} from "../shared/model-policy.ts";

const POLL_MS = 1_000;
export const CANCEL_CLOSE_MS = 2_000;
export const PARENT_REPORT_START = "PI_PARENT_REPORT_BEGIN";
export const PARENT_REPORT_END = "PI_PARENT_REPORT_END";
export const BACKGROUND_SNAPSHOT_VARIABLE = "PI_BACKGROUND_SNAPSHOT";
const VALID_KEYS = new Set([
  "enter",
  "esc",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "ctrl+c",
  "ctrl+d",
  "ctrl+z",
]);

export interface ManagerCallbacks {
  onComplete(task: TaskRecord, output: string): void;
  onChange?(): void;
}

function id(prefix: string) {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}
function cleanLabel(label: string) {
  return label.replace(/\s+/g, " ").trim().slice(0, 80) || "task";
}

export function extractParentReport(output: string) {
  const end = output.lastIndexOf(PARENT_REPORT_END);
  const start = output.lastIndexOf(PARENT_REPORT_START, end);
  if (start >= 0 && end > start) {
    const report = output.slice(start + PARENT_REPORT_START.length, end).trim();
    if (report && report !== "<report>") return report;
  }

  const thinking = [...output.matchAll(/^\s*Thinking\.\.\.\s*$/gm)].at(-1);
  if (thinking?.index !== undefined) {
    const report = output.slice(thinking.index + thinking[0].length).trim();
    if (report) return report;
  }
  return output.trim();
}

export function buildBackgroundScript(
  command: string,
  sentinel: string,
  snapshotMarker: string,
) {
  return `export ${BACKGROUND_SNAPSHOT_VARIABLE}='${snapshotMarker}'\n(\n${command}\n) < /dev/null\nstatus=$?\nprintf '\\n${sentinel}:%s\\n' "$status"`;
}

export function extractFinalBackgroundSnapshot(
  output: string,
  marker?: string,
) {
  if (!marker) return undefined;
  const lines = output.split(/\r?\n/);
  let lastMarker = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.trim() === marker) {
      lastMarker = index;
      break;
    }
  }
  if (lastMarker < 0) return undefined;
  return lines
    .slice(lastMarker + 1)
    .join("\n")
    .trim();
}

export function stripBackgroundSnapshotMarkers(
  output: string,
  marker?: string,
) {
  if (!marker) return output;
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== marker)
    .join("\n");
}

export function buildChildPrompt(options: {
  prompt: string;
  cwd: string;
  kind: TaskRecord["kind"];
  role?: TaskRecord["role"];
  lease?: { leaseId: string; holder: string };
}) {
  const ending =
    options.kind === "subagent"
      ? `- End with exactly one JSON report between these exact marker lines:\n${PARENT_REPORT_START}\n<json-report>\n${PARENT_REPORT_END}\n- The JSON report must contain status (done, question, or failed), summary, changes, verification, risks, question, options, recommendation, and artifacts. Use status question instead of waiting in an interactive prompt.`
      : "- End with a concise report for the parent agent.";
  const scopeGuard =
    options.role === "review" ? `\n\n${REVIEW_SCOPE_GUARD}` : "";
  return `${options.prompt.trim()}${scopeGuard}\n\nOrchestration constraints:\n- Do not spawn subagents or workflows.\n- Work only in ${options.cwd}.\n${options.lease ? `- This is Treehouse lease ${options.lease.leaseId} held by ${options.lease.holder}; do not return or force-clean it.` : "- This task intentionally uses the supplied shared checkout."}\n${ending}`;
}

export function buildAgentName(taskId: string, label: string) {
  const suffix = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, Math.max(0, 31 - taskId.length));
  return suffix ? `${taskId}-${suffix}` : taskId.slice(0, 32);
}

export function advanceAgentLifecycle(
  agent: { status: string; stateChangeSeq?: number },
  promptStateChangeSeq: number | undefined,
  activityObserved: boolean,
) {
  const observed =
    activityObserved ||
    agent.status === "working" ||
    (promptStateChangeSeq !== undefined &&
      agent.stateChangeSeq !== undefined &&
      agent.stateChangeSeq > promptStateChangeSeq);
  return {
    activityObserved: observed,
    settled:
      observed &&
      (agent.status === "idle" ||
        agent.status === "done" ||
        agent.status === "blocked"),
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedReport(output: string) {
  const truncation = truncateTail(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return truncation.truncated
    ? `${truncation.content}\n\n[Final report truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Use subagent_check for full activity.]`
    : truncation.content;
}

export class OrchestrationManager {
  private readonly monitors = new Map<string, AbortController>();
  private readonly closeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  readonly herdr: HerdrClient;
  readonly treehouse: TreehouseClient;
  readonly registry: TaskRegistry;
  private readonly callbacks: ManagerCallbacks;

  constructor(
    herdr: HerdrClient,
    treehouse: TreehouseClient,
    registry: TaskRegistry,
    callbacks: ManagerCallbacks,
  ) {
    this.herdr = herdr;
    this.treehouse = treehouse;
    this.registry = registry;
    this.callbacks = callbacks;
  }

  assertAvailable() {
    if (process.env.HERDR_ENV !== "1")
      throw new Error(
        "Herdr orchestration requires a Pi session running inside Herdr (HERDR_ENV=1). Hidden-process fallback is intentionally disabled.",
      );
  }

  private async createRecord(options: {
    taskId: string;
    label: string;
    kind: TaskRecord["kind"];
    cwd: string;
    placement: Placement;
    parentSession?: string;
    ownerTaskId?: string;
    isolated?: boolean;
    harness?: TaskRecord["harness"];
    role?: TaskRecord["role"];
    model?: string;
    reasoning?: TaskRecord["reasoning"];
    lease?: TaskRecord["lease"];
  }) {
    const parent = await this.herdr.current();
    const placement = resolvePlacement({
      requested: options.placement,
      kind: options.kind,
      isolated: options.isolated,
      expectedLong: true,
    });
    const now = Date.now();
    const provisional: TaskRecord = {
      id: options.taskId,
      label: options.label,
      kind: options.kind,
      parentSession: options.parentSession,
      ownerTaskId: options.ownerTaskId,
      parentWorkspaceId: parent.workspaceId,
      parentTabId: parent.tabId,
      parentPaneId: parent.paneId,
      tabId: parent.tabId,
      paneId: parent.paneId,
      createdTab: false,
      createdPane: false,
      harness: options.harness,
      role: options.role,
      model: options.model,
      reasoning: options.reasoning,
      cwd: options.cwd,
      placement,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      lease: options.lease,
    };
    await this.registry.put(provisional);
    try {
      const resource = await this.herdr.createResource(
        parent,
        placement,
        options.cwd,
        options.label,
      );
      const task = await this.registry.update(provisional.id, {
        tabId: resource.tabId,
        paneId: resource.paneId,
        createdTab: resource.createdTab,
        createdPane: resource.createdPane,
      });
      this.callbacks.onChange?.();
      return task;
    } catch (error) {
      await this.markFailed(provisional.id, error);
      throw error;
    }
  }

  async startBackground(options: {
    command: string;
    label: string;
    cwd: string;
    placement: Placement;
    parentSession?: string;
    ownerTaskId?: string;
    jobKind?: "finite" | "service";
    timeoutMs?: number;
    readyPattern?: string;
    readinessTimeoutMs?: number;
  }) {
    this.assertAvailable();
    const command = options.command.trim();
    if (!command) throw new Error("bg_start command must not be empty.");
    const jobKind = options.jobKind ?? "finite";
    const readyPattern = options.readyPattern?.trim();
    if (jobKind === "service" && !readyPattern)
      throw new Error("Managed services require a readiness pattern.");
    if (jobKind === "finite" && readyPattern)
      throw new Error(
        "Readiness patterns are only valid for managed services.",
      );
    if (readyPattern) new RegExp(readyPattern);
    const ownerTaskId =
      options.ownerTaskId ?? process.env.PI_FIRST_MATE_TASK_ID;
    const taskId = id("bg");
    const label = cleanLabel(options.label);
    const cwd = resolve(options.cwd);
    const task = await this.createRecord({
      taskId,
      label,
      kind: "background",
      cwd,
      placement: options.placement,
      parentSession: options.parentSession,
    });
    await this.registry.update(task.id, {
      ownerTaskId,
      jobKind,
      deadlineAt:
        options.timeoutMs === undefined
          ? undefined
          : Date.now() + options.timeoutMs,
      readinessPattern: readyPattern,
      readinessDeadlineAt:
        jobKind === "service"
          ? Date.now() + (options.readinessTimeoutMs ?? 60_000)
          : undefined,
      stopPolicy: ownerTaskId ? "task" : "parent",
    });
    const sentinel = `__PI_HERDR_DONE_${randomBytes(12).toString("hex")}__`;
    const snapshotMarker = `__PI_HERDR_SNAPSHOT_${randomBytes(12).toString("hex")}__`;
    try {
      const script = buildBackgroundScript(command, sentinel, snapshotMarker);
      await this.herdr.runInPane(task.paneId, "sh", ["-lc", script]);
      await this.registry.update(task.id, {
        status: readyPattern ? "starting" : "running",
        sentinel,
        snapshotMarker,
      });
      this.monitorBackground(task.id, sentinel, snapshotMarker);
      return (await this.registry.get(task.id))!;
    } catch (error) {
      await this.markFailed(task.id, error);
      throw error;
    }
  }

  private monitorBackground(
    taskId: string,
    sentinel: string,
    snapshotMarker?: string,
  ) {
    if (this.monitors.has(taskId)) return;
    const controller = new AbortController();
    this.monitors.set(taskId, controller);
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          let task = await this.registry.get(taskId);
          if (
            !task ||
            (task.status !== "starting" && task.status !== "running")
          )
            return;
          if (task.deadlineAt !== undefined && task.deadlineAt <= Date.now()) {
            await this.herdr.sendKeys(task.paneId, ["ctrl+c"]);
            await sleep(100);
            const timeoutMessage = `The managed ${task.jobKind ?? "finite"} job exceeded its configured runtime.`;
            const captured = await this.herdr
              .readPane(task.paneId, DEFAULT_MAX_LINES)
              .catch(() => "");
            await this.settle(
              task.id,
              "timed-out",
              captured ? `${captured}\n\n${timeoutMessage}` : timeoutMessage,
              {},
              ["starting", "running"],
            );
            return;
          }
          let output: string;
          try {
            output = await this.herdr.readPane(
              task.paneId,
              800,
              controller.signal,
            );
          } catch (error) {
            if (controller.signal.aborted) return;
            if (!(await this.herdr.paneExists(task.paneId))) {
              await this.settle(
                taskId,
                "interrupted",
                "The tracked Herdr pane closed before the command reported an exit status.",
              );
              return;
            }
            throw error;
          }
          if (
            task.status === "starting" &&
            task.readinessDeadlineAt !== undefined &&
            task.readinessDeadlineAt <= Date.now()
          ) {
            await this.herdr.sendKeys(task.paneId, ["ctrl+c"]);
            const error = `Managed service did not match readiness pattern ${JSON.stringify(task.readinessPattern)} before its deadline.`;
            await this.settle(
              task.id,
              "timed-out",
              `${output}\n\n${error}`.trim(),
              { error },
              ["starting"],
            );
            return;
          }
          if (
            task.status === "starting" &&
            task.readinessPattern &&
            new RegExp(task.readinessPattern).test(output)
          ) {
            task = await this.registry.update(task.id, {
              status: "running",
              readinessAt: Date.now(),
            });
            this.callbacks.onChange?.();
          }
          const match = output.match(
            new RegExp(`${escapeRegExp(sentinel)}:(\\d+)`),
          );
          if (match) {
            const exitCode = Number(match[1]);
            const cleaned = output
              .replace(
                new RegExp(`^.*${escapeRegExp(sentinel)}:\\d+.*$`, "gm"),
                "",
              )
              .trimEnd();
            const report = extractFinalBackgroundSnapshot(
              cleaned,
              snapshotMarker,
            );
            const unexpectedServiceExit = task.jobKind === "service";
            const serviceError =
              "Managed service exited before its owner stopped it.";
            const captured = stripBackgroundSnapshotMarkers(
              cleaned,
              snapshotMarker,
            );
            await this.settle(
              taskId,
              unexpectedServiceExit || exitCode !== 0 ? "failed" : "done",
              unexpectedServiceExit
                ? `${captured}\n\n${serviceError}`.trim()
                : captured,
              {
                exitCode,
                ...(unexpectedServiceExit ? { error: serviceError } : {}),
              },
              ["starting", "running"],
              unexpectedServiceExit
                ? `${report}\n\n${serviceError}`.trim()
                : report,
            );
            return;
          }
          if (!(await this.herdr.paneExists(task.paneId))) {
            await this.settle(
              taskId,
              "interrupted",
              "The tracked Herdr pane closed before the command reported an exit status.",
            );
            return;
          }
          await sleep(POLL_MS, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          await this.settle(
            taskId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
      } finally {
        if (this.monitors.get(taskId) === controller)
          this.monitors.delete(taskId);
      }
    })();
  }

  async spawnLeaf(options: SpawnAgentOptions) {
    this.assertAvailable();
    const policy = resolveWorkerPolicy({
      role: options.role,
      harness: options.harness,
      model: options.model,
      reasoning: options.reasoning,
      reviewTargetModel: options.reviewTargetModel,
    });
    await this.herdr.preflightHarness(options.harness);
    const taskId = id(options.kind === "workflow-child" ? "wf" : "sa");
    const label = cleanLabel(options.label);
    const isolation = resolveIsolation(options.isolation, options.prompt);
    const holder = `${taskId}-${label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32)}`;
    const lease =
      isolation === "treehouse"
        ? await this.treehouse.acquire(options.cwd, holder)
        : undefined;
    const cwd = lease?.path ?? resolve(options.cwd);
    const resolvedLaunch = buildHarnessLaunch({
      harness: options.harness,
      model: policy.model,
      reasoning: policy.reasoning,
    });
    let task: TaskRecord | undefined;
    try {
      task = await this.createRecord({
        taskId,
        label,
        kind: options.kind ?? "subagent",
        cwd,
        placement: "tab",
        parentSession: options.parentSession,
        ownerTaskId: options.ownerTaskId ?? process.env.PI_FIRST_MATE_TASK_ID,
        isolated: isolation === "treehouse",
        harness: options.harness,
        role: policy.role,
        model: resolvedLaunch.model,
        reasoning: resolvedLaunch.reasoning,
        lease,
      });
      task = await this.registry.update(task.id, {
        executionMode: "headless",
        harnessSessionId: options.harness === "pi" ? randomUUID() : undefined,
        turn: 0,
      });
      const childPrompt = buildChildPrompt({
        prompt: options.prompt,
        cwd,
        kind: task.kind,
        role: task.role,
        lease,
      });
      return await this.startHeadlessTurn(task, childPrompt);
    } catch (error) {
      if (task) await this.markFailed(task.id, error);
      else if (lease) await this.treehouse.returnLease(lease);
      throw error;
    }
  }

  private async startHeadlessTurn(task: TaskRecord, prompt: string) {
    if (!task.harness)
      throw new Error(`Headless task ${task.id} has no harness.`);
    const turn = (task.turn ?? 0) + 1;
    const { artifacts } = await prepareHeadlessRun({
      taskId: task.id,
      turn,
      prompt,
      harness: {
        harness: task.harness,
        model: task.model,
        reasoning: task.reasoning,
        sessionId: task.harnessSessionId,
        resume: turn > 1,
      },
    });
    await this.registry.update(task.id, {
      executionMode: "headless",
      status: "starting",
      turn,
      runDirectory: artifacts.directory,
      promptPath: artifacts.promptPath,
      outputPath: artifacts.outputPath,
      exitStatusPath: artifacts.exitStatusPath,
      lastMessagePath: artifacts.lastMessagePath,
      settledAt: undefined,
      autoCloseAt: undefined,
      autoCloseCancelled: false,
      resourceClosedAt: undefined,
      completionResultPath: undefined,
      completionReport: undefined,
      error: undefined,
      exitCode: undefined,
    });
    await this.herdr.runInPane(task.paneId, process.execPath, [
      artifacts.scriptPath,
    ]);

    const deadline = Date.now() + HEADLESS_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await hasHeadlessActivity(artifacts, task.harness)) {
        const running = await this.registry.update(task.id, {
          status: "running",
        });
        this.monitorHeadless(running.id, artifacts);
        return running;
      }
      const exitCode = await readHeadlessExit(artifacts);
      if (exitCode !== undefined) {
        const output = await readHeadlessOutput(artifacts);
        const outcome = parseLeafOutcome({
          harness: task.harness,
          output,
          exitCode,
        });
        const error = `Headless ${task.harness} worker exited with code ${exitCode} before producing prompt-acceptance activity.`;
        return this.settle(
          task.id,
          "failed",
          output || error,
          {
            error,
            exitCode,
            harnessSessionId: outcome.sessionId ?? task.harnessSessionId,
          },
          ["starting"],
          outcome.report || error,
        );
      }
      if (!(await this.herdr.paneExists(task.paneId))) {
        const error = `Headless ${task.harness} worker tab closed during startup.`;
        return this.settle(
          task.id,
          "interrupted",
          error,
          { error },
          ["starting"],
          error,
        );
      }
      await sleep(200);
    }
    await this.herdr.sendKeys(task.paneId, ["ctrl+c"]).catch(() => undefined);
    const output = await readHeadlessOutput(artifacts);
    const partial = parseLeafOutcome({
      harness: task.harness,
      output,
      exitCode: 1,
    });
    const uncertain = partial.sessionId !== undefined;
    const error = `Headless ${task.harness} worker produced no prompt-acceptance activity within ${HEADLESS_STARTUP_TIMEOUT_MS / 1_000} seconds.`;
    return this.settle(
      task.id,
      uncertain ? "blocked" : "failed",
      output || error,
      {
        error,
        harnessSessionId: partial.sessionId ?? task.harnessSessionId,
      },
      ["starting"],
      partial.report || error,
    );
  }

  private monitorHeadless(taskId: string, artifacts: HeadlessRunArtifacts) {
    if (this.monitors.has(taskId)) return;
    const controller = new AbortController();
    this.monitors.set(taskId, controller);
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const task = await this.registry.get(taskId);
          if (
            !task ||
            (task.status !== "starting" && task.status !== "running")
          )
            return;
          const exitCode = await readHeadlessExit(artifacts);
          if (exitCode !== undefined) {
            const output = await readHeadlessOutput(artifacts);
            const outcome = parseLeafOutcome({
              harness: task.harness!,
              output,
              exitCode,
              fallbackSessionId: task.harnessSessionId,
            });
            await this.settle(
              task.id,
              outcome.status,
              output,
              {
                exitCode,
                harnessSessionId: outcome.sessionId,
              },
              ["starting", "running"],
              outcome.report,
            );
            return;
          }
          if (!(await this.herdr.paneExists(task.paneId))) {
            await this.settle(
              task.id,
              "interrupted",
              "The tracked headless worker tab closed before the process reported an exit status.",
            );
            return;
          }
          await sleep(POLL_MS, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          await this.settle(
            taskId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
      } finally {
        if (this.monitors.get(taskId) === controller)
          this.monitors.delete(taskId);
      }
    })();
  }

  async spawnAgent(options: SpawnAgentOptions) {
    this.assertAvailable();
    const policy = resolveWorkerPolicy({
      role: options.role,
      harness: options.harness,
      model: options.model,
      reasoning: options.reasoning,
      reviewTargetModel: options.reviewTargetModel,
    });
    const taskId = id(options.kind === "workflow-child" ? "wf" : "sa");
    const label = cleanLabel(options.label);
    const isolation = resolveIsolation(options.isolation, options.prompt);
    const holder = `${taskId}-${label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32)}`;
    const lease =
      isolation === "treehouse"
        ? await this.treehouse.acquire(options.cwd, holder)
        : undefined;
    const cwd = lease?.path ?? resolve(options.cwd);
    const launch = buildHarnessLaunch({
      harness: options.harness,
      model: policy.model,
      reasoning: policy.reasoning,
    });
    let task: TaskRecord | undefined;
    try {
      task = await this.createRecord({
        taskId,
        label,
        kind: options.kind ?? "subagent",
        cwd,
        placement: options.placement,
        parentSession: options.parentSession,
        ownerTaskId: options.ownerTaskId ?? process.env.PI_FIRST_MATE_TASK_ID,
        isolated: isolation === "treehouse",
        harness: options.harness,
        role: policy.role,
        model: launch.model,
        reasoning: launch.reasoning,
        lease,
      });
      const agentName = buildAgentName(taskId, label);
      await this.herdr.startAgent(
        agentName,
        options.harness,
        task.paneId,
        launch.args,
      );
      await this.registry.update(task.id, { agentName });
      const childPrompt = buildChildPrompt({
        prompt: options.prompt,
        cwd,
        kind: task.kind,
        role: task.role,
        lease,
      });
      const prompted = await this.herdr.deliverInitialPrompt({
        name: agentName,
        harness: options.harness,
        paneId: task.paneId,
        launchArgs: launch.args,
        prompt: childPrompt,
      });
      const promptBaseline =
        prompted.baselineStateChangeSeq ?? prompted.stateChangeSeq;
      await this.registry.update(task.id, {
        status: "running",
        promptStateChangeSeq: promptBaseline,
      });
      this.monitorAgent(task.id, promptBaseline);
      return (await this.registry.get(task.id))!;
    } catch (error) {
      if (task) await this.markFailed(task.id, error);
      else if (lease) await this.treehouse.returnLease(lease);
      throw error;
    }
  }

  private monitorAgent(taskId: string, promptStateChangeSeq?: number) {
    if (this.monitors.has(taskId)) return;
    const controller = new AbortController();
    this.monitors.set(taskId, controller);
    void (async () => {
      try {
        let activityObserved = false;
        let unknownSince: number | undefined;
        while (!controller.signal.aborted) {
          const task = await this.registry.get(taskId);
          if (!task || task.status !== "running" || !task.agentName) return;
          let agent: HerdrAgent;
          try {
            agent = await this.herdr.getAgent(task.agentName);
          } catch (error) {
            if (!(await this.herdr.paneExists(task.paneId))) {
              await this.settle(
                task.id,
                "interrupted",
                "The tracked Herdr agent pane closed before completion.",
              );
              return;
            }
            unknownSince ??= Date.now();
            if (Date.now() - unknownSince >= UNKNOWN_AGENT_GRACE_MS) {
              await this.settle(
                task.id,
                "interrupted",
                `Herdr could not identify the tracked agent for ${UNKNOWN_AGENT_GRACE_MS / 60_000} minutes.`,
              );
              return;
            }
            await sleep(POLL_MS, controller.signal);
            continue;
          }
          if (agent.status === "unknown") {
            unknownSince ??= Date.now();
            if (Date.now() - unknownSince >= UNKNOWN_AGENT_GRACE_MS) {
              await this.settle(
                task.id,
                "interrupted",
                `The tracked Herdr agent remained unknown for ${UNKNOWN_AGENT_GRACE_MS / 60_000} minutes.`,
              );
              return;
            }
          } else unknownSince = undefined;
          const lifecycle = advanceAgentLifecycle(
            agent,
            promptStateChangeSeq,
            activityObserved,
          );
          activityObserved = lifecycle.activityObserved;
          if (lifecycle.settled) {
            const status = agent.status === "blocked" ? "blocked" : "done";
            const output = await this.herdr.readAgent(task.agentName);
            await this.settle(
              task.id,
              status,
              output,
              {},
              ["starting", "running"],
              status === "done" && task.kind === "subagent"
                ? extractParentReport(output)
                : undefined,
            );
            return;
          }
          await sleep(POLL_MS, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          await this.settle(
            taskId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
      } finally {
        if (this.monitors.get(taskId) === controller)
          this.monitors.delete(taskId);
      }
    })();
  }

  private async boundedOutput(
    taskId: string,
    output: string,
    fullPath = `${stateDirectory()}/results/${taskId}.txt`,
  ) {
    await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
    await writeFile(fullPath, output, { mode: 0o600 });
    const truncation = truncateTail(output, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    const text = truncation.truncated
      ? `${truncation.content}\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full output: ${fullPath}]`
      : truncation.content;
    return { text, fullPath };
  }

  private async settle(
    taskId: string,
    status: TaskRecord["status"],
    output: string,
    patch: Partial<TaskRecord> = {},
    expectedStatuses: TaskRecord["status"][] = ["starting", "running"],
    completionReport?: string,
  ) {
    const settledAt = Date.now();
    const successful = status === "done";
    const autoClosable = isAutoCloseStatus(status);
    const fullPath = `${stateDirectory()}/results/${taskId}.${randomBytes(5).toString("hex")}.txt`;
    const result = await this.boundedOutput(taskId, output, fullPath);
    const report =
      completionReport === undefined
        ? result.text
        : boundedReport(completionReport);
    const task = await this.registry.transition(taskId, expectedStatuses, {
      ...patch,
      status,
      settledAt,
      completionResultPath: fullPath,
      ...(completionReport === undefined ? {} : { completionReport: report }),
      autoCloseCancelled: false,
      ...(autoClosable ? { autoCloseAt: settledAt + AUTO_CLOSE_MS } : {}),
    });
    if (!task) {
      await unlink(fullPath).catch(() => undefined);
      return this.require(taskId);
    }
    this.callbacks.onComplete(task, report);
    this.callbacks.onChange?.();
    await this.herdr
      .notify(
        `${task.kind} ${status}: ${task.label}`,
        report.slice(0, 500),
        successful ? "done" : "request",
      )
      .catch(() => undefined);
    if (autoClosable) this.scheduleClose(task.id, AUTO_CLOSE_MS);
    return task;
  }

  private markFailed(taskId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return this.settle(taskId, "failed", message, { error: message });
  }

  async enableAutoClose(taskId: string) {
    const task = await this.require(taskId);
    if (!isAutoCloseStatus(task.status)) return task;
    const updated = await this.registry.update(task.id, {
      autoCloseCancelled: false,
      autoCloseAt: Date.now() + AUTO_CLOSE_MS,
    });
    this.scheduleClose(updated.id, AUTO_CLOSE_MS);
    return updated;
  }

  private scheduleClose(taskId: string, delay: number) {
    const existing = this.closeTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.autoClose(taskId);
    }, delay);
    timer.unref?.();
    this.closeTimers.set(taskId, timer);
  }

  private async autoClose(taskId: string) {
    this.closeTimers.delete(taskId);
    const task = await this.registry.get(taskId);
    if (
      !task ||
      task.pinned === true ||
      !isAutoCloseStatus(task.status) ||
      task.resourceClosedAt !== undefined ||
      !task.autoCloseAt ||
      task.autoCloseAt > Date.now()
    )
      return;
    if (task.createdTab && task.tabId) {
      const focused = await this.herdr
        .tabIsFocused(task.tabId)
        .catch(() => false);
      if (focused) {
        const autoCloseAt = Date.now() + AUTO_CLOSE_MS;
        await this.registry.update(task.id, { autoCloseAt });
        this.scheduleClose(task.id, AUTO_CLOSE_MS);
        return;
      }
    }
    try {
      await this.herdr.closeResource(task);
    } catch {
      return;
    }
    let lease = task.lease;
    if (lease?.returnState === "held") {
      lease = await this.treehouse.returnLease(lease);
      if (lease.returnState !== "returned")
        await this.herdr
          .notify(
            `Lease preserved: ${task.label}`,
            lease.returnError ?? "Treehouse return failed",
            "request",
          )
          .catch(() => undefined);
    }
    await this.registry.update(task.id, {
      resourceClosedAt: Date.now(),
      autoCloseCancelled: false,
      ...(lease ? { lease } : {}),
    });
    this.callbacks.onChange?.();
  }

  async reconcile(parentSession?: string) {
    this.assertAvailable();
    const tasks = await this.registry.list();
    for (const task of tasks) {
      if (parentSession && task.parentSession !== parentSession) continue;
      if (task.status === "running" || task.status === "starting") {
        if (
          task.executionMode === "headless" &&
          task.runDirectory &&
          task.promptPath &&
          task.outputPath &&
          task.exitStatusPath &&
          task.lastMessagePath
        )
          this.monitorHeadless(task.id, {
            directory: task.runDirectory,
            promptPath: task.promptPath,
            outputPath: task.outputPath,
            exitStatusPath: task.exitStatusPath,
            lastMessagePath: task.lastMessagePath,
            pidPath: `${task.runDirectory}/pid`,
            scriptPath: `${task.runDirectory}/run.sh`,
          });
        else if (task.kind === "background" && task.sentinel)
          this.monitorBackground(task.id, task.sentinel, task.snapshotMarker);
        else if (task.agentName)
          this.monitorAgent(task.id, task.promptStateChangeSeq);
      } else if (
        task.pinned !== true &&
        isAutoCloseStatus(task.status) &&
        task.resourceClosedAt === undefined
      ) {
        const autoCloseAt =
          task.autoCloseAt ??
          (task.settledAt ?? task.updatedAt) + AUTO_CLOSE_MS;
        if (!task.autoCloseAt || task.autoCloseCancelled)
          await this.registry.update(task.id, {
            autoCloseAt,
            autoCloseCancelled: false,
          });
        this.scheduleClose(task.id, Math.max(0, autoCloseAt - Date.now()));
      }
    }
  }

  dispose() {
    for (const controller of this.monitors.values()) controller.abort();
    this.monitors.clear();
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.closeTimers.clear();
  }

  async list(parentSession?: string) {
    const tasks = await this.registry.list();
    return parentSession
      ? tasks.filter((task) => task.parentSession === parentSession)
      : tasks;
  }

  async output(idValue: string) {
    const task = await this.require(idValue);
    if (task.completionResultPath) {
      try {
        const output = await readFile(task.completionResultPath, "utf8");
        return (await this.boundedOutput(task.id, output)).text;
      } catch {
        // The live Herdr resource may still provide output if durable state was pruned.
      }
    }
    if (task.error) return task.error;
    const output = task.outputPath
      ? await readFile(task.outputPath, "utf8").catch(() => "")
      : task.agentName
        ? await this.herdr.readAgent(task.agentName)
        : await this.herdr.readPane(task.paneId);
    return (await this.boundedOutput(task.id, output)).text;
  }

  async report(idValue: string) {
    const task = await this.require(idValue);
    return task.completionReport ?? this.output(idValue);
  }

  async focus(idValue: string) {
    const task = await this.interact(idValue);
    if (task.agentName) await this.herdr.focusAgent(task.agentName);
    else await this.herdr.focus(task);
    return task;
  }

  async send(idValue: string, text: string) {
    const task = await this.interact(idValue);
    if (task.executionMode === "headless") {
      if (task.resourceClosedAt !== undefined)
        throw new Error(
          `Headless worker ${task.id} has already closed; spawn a recovery worker instead.`,
        );
      return this.startHeadlessTurn(task, text);
    }
    if (task.agentName) {
      const prompted = await this.herdr.promptAgent(task.agentName, text);
      await this.registry.update(task.id, {
        status: "running",
        settledAt: undefined,
        autoCloseAt: undefined,
        autoCloseCancelled: false,
        completionResultPath: undefined,
        error: undefined,
        exitCode: undefined,
        promptStateChangeSeq: prompted.stateChangeSeq,
      });
      this.monitorAgent(task.id, prompted.stateChangeSeq);
    } else await this.herdr.sendText(task.paneId, text);
    return task;
  }

  async keys(idValue: string, keys: string[]) {
    const task = await this.interact(idValue);
    const invalid = keys.filter((key) => !VALID_KEYS.has(key));
    if (invalid.length)
      throw new Error(`Unsupported logical key(s): ${invalid.join(", ")}.`);
    await this.herdr.sendKeys(task.paneId, keys);
    return task;
  }

  async cancel(idValue: string) {
    const task = await this.require(idValue);
    this.monitors.get(task.id)?.abort();
    await this.herdr.sendKeys(task.paneId, ["ctrl+c"]);
    const cancelled = await this.settle(
      task.id,
      "cancelled",
      "The tracked Herdr resource was cancelled.",
      {},
      ["starting", "running", "blocked"],
    );
    if (cancelled.resourceClosedAt !== undefined) return cancelled;

    const autoCloseAt = Date.now() + CANCEL_CLOSE_MS;
    const updated = await this.registry.update(cancelled.id, {
      autoCloseAt,
      autoCloseCancelled: false,
    });
    this.scheduleClose(updated.id, CANCEL_CLOSE_MS);
    return updated;
  }

  async setPinned(idValue: string, pinned: boolean) {
    const task = await this.require(idValue);
    const timer = this.closeTimers.get(task.id);
    if (timer) clearTimeout(timer);
    this.closeTimers.delete(task.id);
    const updated = await this.registry.update(task.id, {
      pinned,
      ...(pinned
        ? { autoCloseAt: undefined }
        : isAutoCloseStatus(task.status)
          ? { autoCloseAt: Date.now() + AUTO_CLOSE_MS }
          : {}),
    });
    if (!pinned && isAutoCloseStatus(updated.status))
      this.scheduleClose(updated.id, AUTO_CLOSE_MS);
    return updated;
  }

  async close(idValue: string) {
    const task = await this.require(idValue);
    this.monitors.get(task.id)?.abort();
    await this.herdr.closeResource(task);
    let lease = task.lease;
    if (lease?.returnState === "held")
      lease = await this.treehouse.returnLease(lease);
    return this.registry.update(task.id, {
      resourceClosedAt: Date.now(),
      ...(lease ? { lease } : {}),
    });
  }

  async attach(idValue: string) {
    const task = await this.interact(idValue);
    if (!task.agentName)
      throw new Error("Only agent tasks support attach/takeover.");
    return this.herdr.attachAgent(task.agentName);
  }

  async wait(ids: string[], signal?: AbortSignal) {
    const pending = new Set(ids);
    while (pending.size) {
      for (const taskId of pending) {
        const task = await this.require(taskId);
        if (task.status !== "starting" && task.status !== "running")
          pending.delete(taskId);
      }
      if (pending.size) await sleep(500, signal);
    }
    return Promise.all(ids.map((taskId) => this.require(taskId)));
  }

  private async interact(idValue: string) {
    const task = await this.require(idValue);
    const timer = this.closeTimers.get(task.id);
    if (timer) clearTimeout(timer);
    this.closeTimers.delete(task.id);
    if (
      task.pinned === true ||
      !isAutoCloseStatus(task.status) ||
      task.resourceClosedAt !== undefined
    )
      return task;
    const autoCloseAt = Date.now() + AUTO_CLOSE_MS;
    const updated = await this.registry.update(task.id, {
      autoCloseCancelled: false,
      autoCloseAt,
    });
    this.scheduleClose(task.id, AUTO_CLOSE_MS);
    return updated;
  }

  private async require(idValue: string) {
    const task = await this.registry.get(idValue);
    if (!task) throw new Error(`Unknown orchestration task ${idValue}.`);
    return task;
  }
}
