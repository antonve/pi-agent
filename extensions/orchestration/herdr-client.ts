import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { CliRunner } from "./cli.ts";
import { decodeJson, findNumber, findObjects, findString } from "./cli.ts";
import type {
  CreatedResource,
  CreatedTaskWorkspace,
  Harness,
  ParentLocation,
  ResolvedPlacement,
} from "./domain.ts";

const DEFAULT_TIMING = {
  agentStartBusyRetries: 100,
  agentStartRetryMs: 100,
  promptReadyPollMs: 200,
  promptReadyConsecutiveReads: 2,
  promptReadyTimeoutMs: 15_000,
  promptActivityTimeoutMs: 10_000,
  promptLateActivityMs: 5_000,
  promptDeliveryAttempts: 3,
} as const;

export interface HerdrTiming {
  agentStartBusyRetries: number;
  agentStartRetryMs: number;
  promptReadyPollMs: number;
  promptReadyConsecutiveReads: number;
  promptReadyTimeoutMs: number;
  promptActivityTimeoutMs: number;
  promptLateActivityMs: number;
  promptDeliveryAttempts: number;
}

export interface HerdrAgent {
  status: string;
  harness?: string;
  name?: string;
  paneId?: string;
  sessionKey?: string;
  stateChangeSeq?: number;
  interactiveReady?: boolean;
  launchPending?: boolean;
}

export interface HerdrPaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrPaneLayout {
  workspaceId: string;
  tabId: string;
  panes: Array<{
    paneId: string;
    focused: boolean;
    rect: HerdrPaneRect;
  }>;
}

export interface HerdrPaneProcessInfo {
  paneId: string;
  foregroundCommandLine?: string;
}

export class HerdrCommandError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrCommandError";
    this.code = code;
  }
}

const RETRYABLE_AGENT_CODES = new Set([
  "agent_not_found",
  "agent_not_ready",
  "agent_not_running",
  "agent_pane_busy",
  "agent_pane_unavailable",
  "agent_launch_pending",
  "agent_prompt_stalled",
]);
const RETRYABLE_AGENT_START_CODES = new Set([
  "agent_not_ready",
  "agent_pane_busy",
  "agent_pane_unavailable",
  "agent_launch_pending",
]);

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function herdrErrorCode(output: string) {
  try {
    return findString(JSON.parse(output), ["code"]);
  } catch {
    return undefined;
  }
}

function commandLabel(args: readonly string[]) {
  if (args[0] === "agent" && args[1] === "prompt" && args.length >= 4)
    return [...args.slice(0, 3), "<prompt>", ...args.slice(4)].join(" ");
  return args.join(" ");
}

function commandError(args: readonly string[], output: string) {
  return new HerdrCommandError(
    `herdr ${commandLabel(args)} failed: ${output}`,
    herdrErrorCode(output),
  );
}

function isRetryableAgentError(error: unknown) {
  return (
    error instanceof HerdrCommandError &&
    error.code !== undefined &&
    RETRYABLE_AGENT_CODES.has(error.code)
  );
}

function decodeAgent(value: unknown): HerdrAgent {
  const record = findObjects(
    value,
    (candidate) =>
      typeof candidate.pane_id === "string" &&
      typeof candidate.agent_status === "string",
  )[0];
  if (!record) throw new Error("Herdr returned no agent state.");
  const session =
    record.agent_session && typeof record.agent_session === "object"
      ? (record.agent_session as Record<string, unknown>)
      : undefined;
  return {
    status: String(record.agent_status),
    harness: typeof record.agent === "string" ? record.agent : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    paneId: String(record.pane_id),
    sessionKey:
      session && typeof session.value === "string" ? session.value : undefined,
    stateChangeSeq:
      typeof record.state_change_seq === "number"
        ? record.state_change_seq
        : undefined,
    interactiveReady:
      typeof record.interactive_ready === "boolean"
        ? record.interactive_ready
        : undefined,
    launchPending:
      typeof record.launch_pending === "boolean"
        ? record.launch_pending
        : undefined,
  };
}

function isPromptReady(
  agent: HerdrAgent,
  expected?: { paneId: string; harness: Harness },
) {
  return (
    (!expected ||
      (agent.paneId === expected.paneId &&
        agent.harness === expected.harness)) &&
    (agent.status === "idle" || agent.status === "done") &&
    agent.stateChangeSeq !== undefined &&
    agent.launchPending !== true &&
    (!expected || agent.interactiveReady === true)
  );
}

function acknowledgedActivity(agent: HerdrAgent, baseline: HerdrAgent) {
  if (agent.paneId !== baseline.paneId || agent.harness !== baseline.harness)
    return false;
  if (agent.status !== "working" && agent.status !== "blocked") return false;
  return (
    agent.stateChangeSeq !== undefined &&
    baseline.stateChangeSeq !== undefined &&
    agent.stateChangeSeq > baseline.stateChangeSeq
  );
}

export class HerdrClient {
  private readonly runner: CliRunner;
  private readonly timing: HerdrTiming;

  private async socketJson<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath)
      throw new Error(
        `HERDR_SOCKET_PATH is unset; Herdr socket API ${method} is unavailable.`,
      );
    return new Promise<T>((resolve, reject) => {
      const requestId = randomUUID();
      const socket = createConnection(socketPath);
      let settled = false;
      let buffer = "";
      const complete = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      const timeout = setTimeout(() => {
        complete(
          new Error(`Timed out waiting for Herdr socket API ${method}.`),
        );
      }, 10_000);
      const abort = () => complete(signal?.reason ?? new Error("cancelled"));
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      socket.on("error", (error) => complete(error));
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let value: {
            id?: string;
            result?: T;
            error?: { code?: string; message?: string };
          };
          try {
            value = decodeJson(
              line,
              `Herdr socket API ${method}`,
            ) as typeof value;
          } catch (error) {
            return complete(error);
          }
          if (value.id !== requestId) continue;
          if (value.error)
            return complete(
              new HerdrCommandError(
                `Herdr socket API ${method} failed: ${value.error.message ?? line}`,
                value.error.code,
              ),
            );
          if (value.result === undefined)
            return complete(
              new Error(`Herdr socket API ${method} returned no result.`),
            );
          return complete(undefined, value.result);
        }
      });
    });
  }

  constructor(runner: CliRunner, timing: Partial<HerdrTiming> = {}) {
    this.runner = runner;
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  private async json(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const result = await this.runner.run("herdr", args, options);
    if (result.code !== 0)
      throw commandError(args, result.stderr || result.stdout);
    return decodeJson(result.stdout, `herdr ${commandLabel(args)}`);
  }

  private async exec(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const result = await this.runner.run("herdr", args, options);
    if (result.code !== 0)
      throw commandError(args, result.stderr || result.stdout);
    return result.stdout;
  }

  async preflightHarness(harness: Harness, signal?: AbortSignal) {
    const result = await this.runner.run(harness, ["--version"], {
      signal,
      timeoutMs: 10_000,
    });
    if (result.code !== 0)
      throw new Error(
        `${harness} headless worker preflight failed: ${result.stderr || result.stdout}`,
      );
  }

  async current(signal?: AbortSignal): Promise<ParentLocation> {
    const value = await this.json(["pane", "current", "--current"], { signal });
    const workspaceId = findString(value, ["workspace_id"]);
    const tabId = findString(value, ["tab_id"]);
    const paneId = findString(value, ["pane_id"]);
    if (!workspaceId || !tabId || !paneId)
      throw new Error(
        "Herdr did not report the current workspace/tab/pane IDs.",
      );
    return { workspaceId, tabId, paneId };
  }

  async createTaskWorkspace(
    cwd: string,
    label: string,
    environment: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<CreatedTaskWorkspace> {
    const envArgs = Object.entries(environment).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);
    const created = await this.json(
      [
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        label,
        ...envArgs,
        "--no-focus",
      ],
      { signal },
    );
    const workspaceId = findString(created, ["workspace_id"]);
    const tabId = findString(created, ["tab_id"]);
    const paneId = findString(created, ["pane_id"]);
    if (!workspaceId || !tabId || !paneId)
      throw new Error(
        "Herdr created a task workspace but did not return its workspace, tab, and root pane IDs.",
      );
    return { workspaceId, tabId, paneId };
  }

  async reportWorkspaceMetadata(
    workspaceId: string,
    source: string,
    tokens: Record<string, string>,
    options: { sequence?: number; ttlMs?: number } = {},
  ) {
    const args = [
      "workspace",
      "report-metadata",
      workspaceId,
      "--source",
      source,
      ...Object.entries(tokens).flatMap(([key, value]) => [
        "--token",
        `${key}=${value}`,
      ]),
      ...(options.sequence === undefined
        ? []
        : ["--seq", String(options.sequence)]),
      ...(options.ttlMs === undefined
        ? []
        : ["--ttl-ms", String(options.ttlMs)]),
    ];
    return this.json(args);
  }

  async workspaceIsFocused(workspaceId: string) {
    const value = await this.json(["workspace", "get", workspaceId], {
      timeoutMs: 5_000,
    });
    const workspace = findObjects(
      value,
      (candidate) => candidate.workspace_id === workspaceId,
    )[0];
    return workspace?.focused === true;
  }

  async renameWorkspace(workspaceId: string, label: string) {
    return this.json(["workspace", "rename", workspaceId, label]);
  }

  async renameTab(tabId: string, label: string) {
    return this.json(["tab", "rename", tabId, label]);
  }

  async moveWorkspace(
    workspaceId: string,
    insertIndex: number,
    signal?: AbortSignal,
  ) {
    return this.socketJson(
      "workspace.move",
      {
        workspace_id: workspaceId,
        insert_index: insertIndex,
      },
      signal,
    );
  }

  async focusPane(paneId: string, signal?: AbortSignal) {
    return this.socketJson("pane.focus", { pane_id: paneId }, signal);
  }

  async renamePane(paneId: string, label: string, signal?: AbortSignal) {
    return this.json(["pane", "rename", paneId, label], { signal });
  }

  async layout(paneId: string, signal?: AbortSignal): Promise<HerdrPaneLayout> {
    const value = await this.json(["pane", "layout", "--pane", paneId], {
      signal,
      timeoutMs: 5_000,
    });
    const layout = findObjects(
      value,
      (candidate) =>
        typeof candidate.workspace_id === "string" &&
        typeof candidate.tab_id === "string" &&
        Array.isArray(candidate.panes),
    )[0];
    if (!layout)
      throw new Error(`Herdr returned no layout for pane ${paneId}.`);
    return {
      workspaceId: String(layout.workspace_id),
      tabId: String(layout.tab_id),
      panes: Array.isArray(layout.panes)
        ? layout.panes
            .map((pane) => {
              if (!pane || typeof pane !== "object") return undefined;
              const record = pane as Record<string, unknown>;
              const rect =
                record.rect && typeof record.rect === "object"
                  ? (record.rect as Record<string, unknown>)
                  : undefined;
              if (
                typeof record.pane_id !== "string" ||
                !rect ||
                typeof rect.x !== "number" ||
                typeof rect.y !== "number" ||
                typeof rect.width !== "number" ||
                typeof rect.height !== "number"
              )
                return undefined;
              return {
                paneId: record.pane_id,
                focused: record.focused === true,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              };
            })
            .filter((pane) => pane !== undefined)
        : [],
    };
  }

  async processInfo(
    paneId: string,
    signal?: AbortSignal,
  ): Promise<HerdrPaneProcessInfo> {
    const value = await this.json(["pane", "process-info", "--pane", paneId], {
      signal,
      timeoutMs: 5_000,
    });
    const info = findObjects(
      value,
      (candidate) =>
        typeof candidate.pane_id === "string" &&
        Array.isArray(candidate.foreground_processes),
    )[0];
    if (!info)
      throw new Error(`Herdr returned no process info for pane ${paneId}.`);
    const commandLine = Array.isArray(info.foreground_processes)
      ? info.foreground_processes.find(
          (process) =>
            process &&
            typeof process === "object" &&
            typeof (process as Record<string, unknown>).cmdline === "string",
        )
      : undefined;
    return {
      paneId: String(info.pane_id),
      foregroundCommandLine:
        commandLine && typeof commandLine === "object"
          ? String((commandLine as Record<string, unknown>).cmdline)
          : undefined,
    };
  }

  private async focusedPane() {
    const listed = await this.json(["workspace", "list"], { timeoutMs: 5_000 });
    const workspace = findObjects(
      listed,
      (candidate) =>
        typeof candidate.workspace_id === "string" &&
        candidate.focused === true,
    )[0];
    if (!workspace) return undefined;
    const workspaceId = String(workspace.workspace_id);
    const panes = await this.json(
      ["pane", "list", "--workspace", workspaceId],
      { timeoutMs: 5_000 },
    );
    const pane = findObjects(
      panes,
      (candidate) =>
        typeof candidate.pane_id === "string" && candidate.focused === true,
    )[0];
    if (!pane) return undefined;
    return { workspaceId, paneId: String(pane.pane_id) };
  }

  async closeWorkspace(workspaceId: string) {
    const focused = await this.focusedPane().catch(() => undefined);
    try {
      await this.json(["workspace", "close", workspaceId]);
    } catch (error) {
      if (
        error instanceof HerdrCommandError &&
        error.code === "workspace_not_found"
      )
        return;
      throw error;
    }
    if (focused && focused.workspaceId !== workspaceId) {
      const stillFocused = await this.workspaceIsFocused(
        focused.workspaceId,
      ).catch(() => false);
      if (!stillFocused)
        await this.focusPane(focused.paneId).catch(() => undefined);
    }
  }

  async swapPanes(sourcePaneId: string, targetPaneId: string) {
    return this.json([
      "pane",
      "swap",
      "--source-pane",
      sourcePaneId,
      "--target-pane",
      targetPaneId,
    ]);
  }

  async splitPane(
    paneId: string,
    cwd: string,
    options: {
      direction: "right" | "down";
      ratio: number;
      noFocus?: boolean;
    },
    signal?: AbortSignal,
  ) {
    const created = await this.json(
      [
        "pane",
        "split",
        "--pane",
        paneId,
        "--direction",
        options.direction,
        "--ratio",
        String(options.ratio),
        "--cwd",
        cwd,
        ...(options.noFocus ? ["--no-focus"] : []),
      ],
      { signal },
    );
    const createdPaneId = findString(created, ["pane_id"]);
    if (!createdPaneId)
      throw new Error("Herdr created a pane but returned no pane ID.");
    return { paneId: createdPaneId };
  }

  async createResource(
    parent: ParentLocation,
    placement: ResolvedPlacement,
    cwd: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<CreatedResource> {
    if (placement === "tab") {
      const created = await this.json(
        [
          "tab",
          "create",
          "--workspace",
          parent.workspaceId,
          "--cwd",
          cwd,
          "--label",
          label,
          "--no-focus",
        ],
        { signal },
      );
      const tabId = findString(created, ["tab_id"]);
      if (!tabId)
        throw new Error("Herdr created a tab but returned no tab ID.");
      const paneId = findString(created, ["pane_id"]);
      if (!paneId) throw new Error(`Herdr tab ${tabId} returned no root pane.`);
      return {
        placement,
        workspaceId: parent.workspaceId,
        tabId,
        paneId,
        createdTab: true,
        createdPane: true,
      };
    }

    const created = await this.json(
      [
        "pane",
        "split",
        "--pane",
        parent.paneId,
        "--direction",
        "right",
        "--ratio",
        "0.5",
        "--cwd",
        cwd,
        "--no-focus",
      ],
      { signal },
    );
    const paneId = findString(created, ["pane_id"]);
    if (!paneId)
      throw new Error("Herdr created a pane but returned no pane ID.");
    await this.json(["pane", "rename", paneId, label], { signal });
    return {
      placement,
      workspaceId: parent.workspaceId,
      tabId: parent.tabId,
      paneId,
      createdTab: false,
      createdPane: true,
    };
  }

  runInPane(
    paneId: string,
    command: string,
    args: string[],
    signal?: AbortSignal,
  ) {
    const commandLine = [command, ...args].map(shellQuote).join(" ");
    return this.exec(["pane", "run", paneId, commandLine], { signal });
  }

  async readPane(paneId: string, lines = 400, signal?: AbortSignal) {
    const result = await this.runner.run(
      "herdr",
      [
        "pane",
        "read",
        paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ],
      { signal, timeoutMs: 10_000 },
    );
    if (result.code !== 0)
      throw new Error(
        `herdr pane read failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout;
  }

  async tabIsFocused(tabId: string) {
    const value = await this.json(["tab", "get", tabId], {
      timeoutMs: 5_000,
    });
    const tab = findObjects(
      value,
      (candidate) => candidate.tab_id === tabId,
    )[0];
    return tab?.focused === true;
  }

  async paneExists(paneId: string) {
    const result = await this.runner.run("herdr", ["pane", "get", paneId], {
      timeoutMs: 5_000,
    });
    return result.code === 0;
  }

  async closePane(paneId: string) {
    try {
      await this.json(["pane", "close", paneId]);
    } catch (error) {
      if (error instanceof HerdrCommandError && error.code === "pane_not_found")
        return;
      throw error;
    }
  }

  async closeResource(task: {
    createdTab: boolean;
    tabId?: string;
    createdPane: boolean;
    paneId: string;
  }) {
    if (!(await this.paneExists(task.paneId))) return;
    try {
      if (task.createdTab && task.tabId)
        await this.json(["tab", "close", task.tabId]);
      else if (task.createdPane)
        await this.json(["pane", "close", task.paneId]);
    } catch (error) {
      if (
        error instanceof HerdrCommandError &&
        (error.code === "pane_not_found" || error.code === "tab_not_found")
      )
        return;
      throw error;
    }
  }

  async focus(task: {
    placement: ResolvedPlacement;
    tabId?: string;
    paneId: string;
    parentPaneId: string;
  }) {
    if (task.tabId) await this.json(["tab", "focus", task.tabId]);
    if (task.placement === "pane")
      await this.json([
        "pane",
        "focus",
        "--pane",
        task.parentPaneId,
        "--direction",
        "right",
      ]);
  }

  sendText(paneId: string, text: string) {
    return this.exec(["pane", "send-text", paneId, text]);
  }
  sendKeys(paneId: string, keys: string[]) {
    return this.exec(["pane", "send-keys", paneId, ...keys]);
  }

  async startAgent(
    name: string,
    harness: Harness,
    paneId: string,
    args: string[],
    signal?: AbortSignal,
  ) {
    const commandArgs = [
      "agent",
      "start",
      name,
      "--kind",
      harness,
      "--pane",
      paneId,
      "--timeout",
      "60000",
      ...(args.length ? ["--", ...args] : []),
    ];
    for (let attempt = 0; ; attempt++) {
      const result = await this.runner.run("herdr", commandArgs, {
        signal,
        timeoutMs: 70_000,
      });
      if (result.code === 0)
        return decodeJson(result.stdout, `herdr ${commandArgs.join(" ")}`);
      const output = result.stderr || result.stdout;
      if (
        attempt >= this.timing.agentStartBusyRetries ||
        !RETRYABLE_AGENT_START_CODES.has(herdrErrorCode(output) ?? "")
      )
        throw commandError(commandArgs, output);
      await delay(this.timing.agentStartRetryMs, signal);
    }
  }
  private async resolveAgent(
    name: string,
    expected?: { paneId: string; harness: Harness },
  ) {
    try {
      return await this.getAgent(name);
    } catch (error) {
      if (!expected || !isRetryableAgentError(error)) throw error;
      try {
        const replacement = await this.getAgent(expected.paneId);
        if (
          replacement.paneId !== expected.paneId ||
          replacement.harness !== expected.harness
        )
          throw error;
        if (replacement.name !== name) {
          await this.json(["agent", "rename", expected.paneId, name]);
          replacement.name = name;
        }
        return replacement;
      } catch (paneError) {
        if (!isRetryableAgentError(paneError)) throw paneError;
        throw error;
      }
    }
  }

  async waitForAgentPromptReady(
    name: string,
    expected?: { paneId: string; harness: Harness },
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + this.timing.promptReadyTimeoutMs;
    let stableKey: string | undefined;
    let consecutiveReads = 0;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const agent = await this.resolveAgent(name, expected);
        if (isPromptReady(agent, expected)) {
          const key = `${agent.paneId}:${agent.harness}:${agent.sessionKey ?? "missing"}:${agent.stateChangeSeq ?? "missing"}`;
          consecutiveReads = key === stableKey ? consecutiveReads + 1 : 1;
          stableKey = key;
          if (consecutiveReads >= this.timing.promptReadyConsecutiveReads)
            return agent;
        } else {
          stableKey = undefined;
          consecutiveReads = 0;
        }
      } catch (error) {
        if (!isRetryableAgentError(error)) throw error;
        lastError = error;
        stableKey = undefined;
        consecutiveReads = 0;
      }
      await delay(this.timing.promptReadyPollMs, signal);
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(
      `Herdr agent ${name} did not reach an interactive prompt${detail}`,
    );
  }

  private async promptAgentForActivity(
    name: string,
    prompt: string,
    signal?: AbortSignal,
  ) {
    // Herdr prompt without --wait acknowledges only terminal input. Waiting for
    // working/blocked makes child lifecycle activity the delivery receipt.
    const args = [
      "agent",
      "prompt",
      name,
      prompt,
      "--wait",
      "--until",
      "working",
      "--until",
      "blocked",
      "--timeout",
      String(this.timing.promptActivityTimeoutMs),
    ];
    const value = await this.json(args, {
      signal,
      timeoutMs: this.timing.promptActivityTimeoutMs + 5_000,
    });
    return decodeAgent(value);
  }

  private async observeLatePromptActivity(
    name: string,
    baseline: HerdrAgent,
    expected: { paneId: string; harness: Harness },
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + this.timing.promptLateActivityMs;
    while (Date.now() < deadline) {
      try {
        const agent = await this.resolveAgent(name, expected);
        if (acknowledgedActivity(agent, baseline)) return agent;
      } catch (error) {
        if (!isRetryableAgentError(error)) throw error;
      }
      await delay(this.timing.promptReadyPollMs, signal);
    }
    return undefined;
  }

  async deliverInitialPrompt(options: {
    name: string;
    harness: Harness;
    paneId: string;
    launchArgs: string[];
    prompt: string;
    signal?: AbortSignal;
  }) {
    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= this.timing.promptDeliveryAttempts;
      attempt++
    ) {
      let baseline: HerdrAgent;
      try {
        baseline = await this.waitForAgentPromptReady(
          options.name,
          { paneId: options.paneId, harness: options.harness },
          options.signal,
        );
      } catch (error) {
        lastError = error;
        if (attempt >= this.timing.promptDeliveryAttempts) break;
        try {
          await this.startAgent(
            options.name,
            options.harness,
            options.paneId,
            options.launchArgs,
            options.signal,
          );
        } catch (startError) {
          lastError = startError;
          if (
            startError instanceof HerdrCommandError &&
            !isRetryableAgentError(startError)
          )
            break;
        }
        continue;
      }

      try {
        const acknowledged = await this.promptAgentForActivity(
          options.name,
          options.prompt,
          options.signal,
        );
        if (!acknowledgedActivity(acknowledged, baseline))
          throw new Error(
            `Herdr agent ${options.name} returned without post-submission activity`,
          );
        return {
          stateChangeSeq: acknowledged.stateChangeSeq,
          baselineStateChangeSeq: baseline.stateChangeSeq,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        const late = await this.observeLatePromptActivity(
          options.name,
          baseline,
          { paneId: options.paneId, harness: options.harness },
          options.signal,
        );
        if (late)
          return {
            stateChangeSeq: late.stateChangeSeq,
            baselineStateChangeSeq: baseline.stateChangeSeq,
            attempts: attempt,
          };
        if (
          attempt >= this.timing.promptDeliveryAttempts ||
          (error instanceof HerdrCommandError && !isRetryableAgentError(error))
        )
          break;
      }
    }
    const detail =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Initial prompt delivery to ${options.harness} agent ${options.name} in pane ${options.paneId} was not acknowledged after ${this.timing.promptDeliveryAttempts} attempts: ${detail}`,
    );
  }

  async promptAgent(name: string, prompt: string, signal?: AbortSignal) {
    const value = await this.json(["agent", "prompt", name, prompt], {
      signal,
      timeoutMs: 20_000,
    });
    const stateChangeSeq = findNumber(value, ["state_change_seq"]);
    if (stateChangeSeq === undefined)
      throw new Error("herdr agent prompt returned no state_change_seq");
    return { stateChangeSeq };
  }
  async getAgent(name: string): Promise<HerdrAgent> {
    const value = await this.json(["agent", "get", name], {
      timeoutMs: 10_000,
    });
    return decodeAgent(value);
  }

  async agentExists(target: string) {
    try {
      await this.getAgent(target);
      return true;
    } catch (error) {
      if (
        error instanceof HerdrCommandError &&
        error.code === "agent_not_found"
      )
        return false;
      throw error;
    }
  }
  async readAgent(name: string, lines = 600) {
    const result = await this.runner.run(
      "herdr",
      [
        "agent",
        "read",
        name,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ],
      { timeoutMs: 10_000 },
    );
    if (result.code !== 0)
      throw new Error(
        `herdr agent read failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout;
  }
  focusAgent(name: string) {
    return this.json(["agent", "focus", name]);
  }
  attachAgent(name: string) {
    return this.runner.run("herdr", ["agent", "attach", name, "--takeover"], {
      timeoutMs: 10_000,
    });
  }
  notify(
    title: string,
    body: string,
    sound: "none" | "done" | "request" = "done",
  ) {
    return this.json([
      "notification",
      "show",
      title,
      "--body",
      body.slice(0, 2_000),
      "--sound",
      sound,
    ]);
  }
}
