import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  formatSize,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import type {
  CreatedResource,
  Placement,
  SpawnAgentOptions,
  TaskRecord,
} from "./domain.ts";
import { buildHarnessLaunch } from "./harnesses.ts";
import { HerdrClient } from "./herdr-client.ts";
import { resolveIsolation, resolvePlacement } from "./placement.ts";
import { TaskRegistry, stateDirectory } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";

const AUTO_CLOSE_MS = 30_000;
const POLL_MS = 1_000;
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
    isolated?: boolean;
    harness?: TaskRecord["harness"];
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
    const resource = await this.herdr.createResource(
      parent,
      placement,
      options.cwd,
      options.label,
    );
    const now = Date.now();
    const task: TaskRecord = {
      id: options.taskId,
      label: options.label,
      kind: options.kind,
      parentSession: options.parentSession,
      parentWorkspaceId: parent.workspaceId,
      parentTabId: parent.tabId,
      parentPaneId: parent.paneId,
      tabId: resource.tabId,
      paneId: resource.paneId,
      createdTab: resource.createdTab,
      createdPane: resource.createdPane,
      harness: options.harness,
      model: options.model,
      reasoning: options.reasoning,
      cwd: options.cwd,
      placement,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      lease: options.lease,
    };
    await this.registry.put(task);
    this.callbacks.onChange?.();
    return task;
  }

  async startBackground(options: {
    command: string;
    label: string;
    cwd: string;
    placement: Placement;
    parentSession?: string;
  }) {
    this.assertAvailable();
    const command = options.command.trim();
    if (!command) throw new Error("bg_start command must not be empty.");
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
    const sentinel = `__PI_HERDR_DONE_${randomBytes(12).toString("hex")}__`;
    try {
      const script = `${command}\nstatus=$?\nprintf '\\n${sentinel}:%s\\n' "$status"`;
      await this.herdr.runInPane(task.paneId, "sh", ["-lc", script]);
      await this.registry.update(task.id, { status: "running", sentinel });
      this.monitorBackground(task.id, sentinel);
      return (await this.registry.get(task.id))!;
    } catch (error) {
      await this.registry.update(task.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        settledAt: Date.now(),
      });
      throw error;
    }
  }

  private monitorBackground(taskId: string, sentinel: string) {
    const controller = new AbortController();
    this.monitors.set(taskId, controller);
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const task = await this.registry.get(taskId);
          if (!task || task.status !== "running") return;
          const output = await this.herdr.readPane(
            task.paneId,
            800,
            controller.signal,
          );
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
            await this.settle(
              taskId,
              exitCode === 0 ? "done" : "failed",
              cleaned,
              { exitCode },
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
        this.monitors.delete(taskId);
      }
    })();
  }

  async spawnAgent(options: SpawnAgentOptions) {
    this.assertAvailable();
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
      model: options.model,
      reasoning: options.reasoning,
      parentModel: options.parentModel,
      parentReasoning: options.parentReasoning,
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
        isolated: isolation === "treehouse",
        harness: options.harness,
        model: launch.model,
        reasoning: launch.reasoning,
        lease,
      });
      const agentName = `${taskId}-${label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 28)}`;
      await this.herdr.startAgent(
        agentName,
        options.harness,
        task.paneId,
        launch.args,
      );
      await this.registry.update(task.id, { agentName, status: "running" });
      const childPrompt = `${options.prompt.trim()}\n\nOrchestration constraints:\n- Do not spawn subagents or workflows.\n- Work only in ${cwd}.\n${lease ? `- This is Treehouse lease ${lease.leaseId} held by ${lease.holder}; do not return or force-clean it.` : "- This task intentionally uses the supplied shared checkout."}\n- End with a concise report for the parent agent.`;
      await this.herdr.promptAgent(agentName, childPrompt);
      this.monitorAgent(task.id);
      return (await this.registry.get(task.id))!;
    } catch (error) {
      if (task)
        await this.registry.update(task.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          settledAt: Date.now(),
        });
      else if (lease) await this.treehouse.returnLease(lease);
      throw error;
    }
  }

  private monitorAgent(taskId: string) {
    const controller = new AbortController();
    this.monitors.set(taskId, controller);
    void (async () => {
      try {
        let polls = 0;
        while (!controller.signal.aborted) {
          const task = await this.registry.get(taskId);
          if (!task || task.status !== "running" || !task.agentName) return;
          const agent = await this.herdr.getAgent(task.agentName);
          polls++;
          if (agent.status === "blocked") {
            await this.settle(
              task.id,
              "blocked",
              await this.herdr.readAgent(task.agentName),
            );
            return;
          }
          if (
            agent.status === "done" ||
            (agent.status === "idle" && polls > 1)
          ) {
            await this.settle(
              task.id,
              "done",
              await this.herdr.readAgent(task.agentName),
            );
            return;
          }
          if (
            agent.status === "unknown" &&
            !(await this.herdr.paneExists(task.paneId))
          ) {
            await this.settle(
              task.id,
              "interrupted",
              "The tracked Herdr agent pane closed before completion.",
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
        this.monitors.delete(taskId);
      }
    })();
  }

  private async boundedOutput(taskId: string, output: string) {
    const directory = `${stateDirectory()}/results`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fullPath = `${directory}/${taskId}.txt`;
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
  ) {
    const result = await this.boundedOutput(taskId, output);
    const settledAt = Date.now();
    const successful = status === "done";
    const task = await this.registry.update(taskId, {
      ...patch,
      status,
      settledAt,
      completionResultPath: result.fullPath,
      ...(successful ? { autoCloseAt: settledAt + AUTO_CLOSE_MS } : {}),
    });
    this.callbacks.onComplete(task, result.text);
    this.callbacks.onChange?.();
    await this.herdr
      .notify(
        `${task.kind} ${status}: ${task.label}`,
        result.text.slice(0, 500),
        successful ? "done" : "request",
      )
      .catch(() => undefined);
    if (successful) this.scheduleClose(task.id, AUTO_CLOSE_MS);
    return task;
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
      task.status !== "done" ||
      task.autoCloseCancelled ||
      !task.autoCloseAt ||
      task.autoCloseAt > Date.now()
    )
      return;
    await this.herdr.closeResource(task).catch(() => undefined);
    if (task.lease?.returnState === "held") {
      const lease = await this.treehouse.returnLease(task.lease);
      await this.registry.update(task.id, { lease });
      if (lease.returnState !== "returned")
        await this.herdr
          .notify(
            `Lease preserved: ${task.label}`,
            lease.returnError ?? "Treehouse return failed",
            "request",
          )
          .catch(() => undefined);
    }
  }

  async reconcile() {
    this.assertAvailable();
    const tasks = await this.registry.list();
    for (const task of tasks) {
      if (task.status === "running") {
        if (task.kind === "background" && task.sentinel)
          this.monitorBackground(task.id, task.sentinel);
        else if (task.agentName) this.monitorAgent(task.id);
      } else if (
        task.status === "done" &&
        task.autoCloseAt &&
        !task.autoCloseCancelled
      ) {
        this.scheduleClose(task.id, Math.max(0, task.autoCloseAt - Date.now()));
      }
    }
  }

  async list(parentSession?: string) {
    const tasks = await this.registry.list();
    return parentSession
      ? tasks.filter((task) => task.parentSession === parentSession)
      : tasks;
  }

  async output(idValue: string) {
    const task = await this.require(idValue);
    const output = task.agentName
      ? await this.herdr.readAgent(task.agentName)
      : await this.herdr.readPane(task.paneId);
    return (await this.boundedOutput(task.id, output)).text;
  }

  async focus(idValue: string) {
    const task = await this.interact(idValue);
    if (task.agentName) await this.herdr.focusAgent(task.agentName);
    else await this.herdr.focus(task);
    return task;
  }

  async send(idValue: string, text: string) {
    const task = await this.interact(idValue);
    if (task.agentName) {
      await this.registry.update(task.id, {
        status: "running",
        settledAt: undefined,
        autoCloseAt: undefined,
      });
      await this.herdr.promptAgent(task.agentName, text);
      this.monitorAgent(task.id);
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
    const task = await this.interact(idValue);
    await this.herdr.sendKeys(task.paneId, ["ctrl+c"]);
    this.monitors.get(task.id)?.abort();
    await this.registry.update(task.id, {
      status: "cancelled",
      settledAt: Date.now(),
    });
    return task;
  }

  async close(idValue: string) {
    const task = await this.require(idValue);
    this.monitors.get(task.id)?.abort();
    await this.herdr.closeResource(task);
    if (task.lease?.returnState === "held") {
      const lease = await this.treehouse.returnLease(task.lease);
      await this.registry.update(task.id, { lease });
    }
    return task;
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
    return this.registry.update(task.id, {
      autoCloseCancelled: true,
      autoCloseAt: undefined,
    });
  }

  private async require(idValue: string) {
    const task = await this.registry.get(idValue);
    if (!task) throw new Error(`Unknown orchestration task ${idValue}.`);
    return task;
  }
}
