import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { nodeCliRunner, type CliRunner } from "./cli.ts";
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

interface BackgroundFocusTargets {
  workspaceIds: string[];
  tabIds: string[];
  paneIds: string[];
}

let backgroundFocusQueue = Promise.resolve();

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

function argumentAfter(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function argumentsAfter(args: readonly string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index++)
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!);
  return values;
}

function environmentArguments(args: readonly string[]) {
  return Object.fromEntries(
    argumentsAfter(args, "--env").map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0
        ? [entry, ""]
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function backgroundFocusTargets(
  args: readonly string[],
): BackgroundFocusTargets | undefined {
  const [kind, action] = args;
  if (!kind || !action || action === "focus" || action === "attach")
    return undefined;
  const targets: BackgroundFocusTargets = {
    workspaceIds: [],
    tabIds: [],
    paneIds: [],
  };
  if (kind === "workspace") {
    if (action !== "create") {
      if (["close", "move", "rename"].includes(action) && args[2])
        targets.workspaceIds.push(args[2]);
      else return undefined;
    }
  } else if (kind === "tab") {
    if (action !== "create") {
      if (["close", "move", "rename"].includes(action) && args[2])
        targets.tabIds.push(args[2]);
      else return undefined;
    }
  } else if (kind === "pane") {
    if (action === "split") {
      const paneId = argumentAfter(args, "--pane");
      if (paneId) targets.paneIds.push(paneId);
    } else if (action === "swap") {
      const source = argumentAfter(args, "--source-pane");
      const target = argumentAfter(args, "--target-pane");
      if (source) targets.paneIds.push(source);
      if (target) targets.paneIds.push(target);
    } else if (action === "resize") {
      const paneId = argumentAfter(args, "--pane");
      if (paneId) targets.paneIds.push(paneId);
    } else if (
      ["close", "rename", "run", "send-text", "send-keys"].includes(action)
    ) {
      if (args[2]) targets.paneIds.push(args[2]);
    } else return undefined;
  } else if (kind === "agent") {
    if (action === "start") {
      const paneId = argumentAfter(args, "--pane");
      if (paneId) targets.paneIds.push(paneId);
    } else if (action !== "prompt" && action !== "rename") return undefined;
  } else return undefined;
  return targets;
}

function resultFocusTargets(output: string) {
  try {
    const value = JSON.parse(output);
    return {
      workspaceId: findString(value, ["workspace_id"]),
      tabId: findString(value, ["tab_id"]),
      paneId: findString(value, ["pane_id"]),
    };
  } catch {
    return {};
  }
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
  private readonly guardBackgroundFocus: boolean;

  private async socketJson<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 10_000,
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
      }, timeoutMs);
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

  constructor(
    runner: CliRunner,
    timing: Partial<HerdrTiming> = {},
    options: { guardBackgroundFocus?: boolean } = {},
  ) {
    this.runner = runner;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.guardBackgroundFocus =
      options.guardBackgroundFocus ?? runner === nodeCliRunner;
  }

  private async targetPaneIds(targets: BackgroundFocusTargets) {
    const paneIds = new Set(targets.paneIds);
    for (const workspaceId of targets.workspaceIds) {
      const value = await this.runner
        .run("herdr", ["pane", "list", "--workspace", workspaceId], {
          timeoutMs: 5_000,
        })
        .catch(() => undefined);
      if (!value || value.code !== 0) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(value.stdout);
      } catch {
        continue;
      }
      for (const pane of findObjects(
        decoded,
        (candidate) =>
          typeof candidate.pane_id === "string" && candidate.focused === true,
      ))
        paneIds.add(String(pane.pane_id));
    }
    for (const tabId of targets.tabIds) {
      const tab = await this.runner
        .run("herdr", ["tab", "get", tabId], { timeoutMs: 5_000 })
        .catch(() => undefined);
      let workspaceId: string | undefined;
      if (tab?.code === 0)
        try {
          workspaceId = findString(JSON.parse(tab.stdout), ["workspace_id"]);
        } catch {
          // Treat malformed discovery as an unavailable target location.
        }
      if (!workspaceId) continue;
      const panes = await this.runner
        .run("herdr", ["pane", "list", "--workspace", workspaceId], {
          timeoutMs: 5_000,
        })
        .catch(() => undefined);
      if (!panes || panes.code !== 0) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(panes.stdout);
      } catch {
        continue;
      }
      for (const pane of findObjects(
        decoded,
        (candidate) =>
          candidate.tab_id === tabId &&
          typeof candidate.pane_id === "string" &&
          candidate.focused === true,
      ))
        paneIds.add(String(pane.pane_id));
    }
    return paneIds;
  }

  private async backgroundMutation<T>(
    targets: BackgroundFocusTargets,
    operation: () => Promise<T>,
    output: (result: T) => string,
  ) {
    if (!this.guardBackgroundFocus) return operation();
    const previous = backgroundFocusQueue;
    let release!: () => void;
    backgroundFocusQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    const targetPaneIds = await this.targetPaneIds(targets).catch(
      () => new Set(targets.paneIds),
    );
    const started = await this.focusedPane().catch(() => undefined);
    let result: T | undefined;
    try {
      result = await operation();
      return result;
    } finally {
      try {
        const current = await this.focusedPane().catch(() => undefined);
        const dynamic =
          result === undefined ? {} : resultFocusTargets(output(result));
        const affected =
          current !== undefined &&
          (targetPaneIds.has(current.paneId) ||
            dynamic.paneId === current.paneId);
        const changed =
          started !== undefined &&
          current !== undefined &&
          (started.workspaceId !== current.workspaceId ||
            started.tabId !== current.tabId ||
            started.paneId !== current.paneId);
        // An unrelated destination is user navigation, not focus theft. Never
        // override it. A target destination can only come from this direct
        // background operation, so restore the exact starting pane.
        if (affected && changed)
          await this.focusPane(started.paneId).catch(() => undefined);
      } finally {
        release();
      }
    }
  }

  private async nativeBackgroundCommand(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number },
  ) {
    const [kind, action] = args;
    let method: string;
    let params: Record<string, unknown>;
    if (kind === "workspace" && action === "create") {
      method = "workspace.create";
      params = {
        cwd: argumentAfter(args, "--cwd"),
        label: argumentAfter(args, "--label"),
        env: environmentArguments(args),
        focus: false,
      };
    } else if (kind === "workspace" && action === "rename") {
      method = "workspace.rename";
      params = { workspace_id: args[2], label: args[3] };
    } else if (kind === "workspace" && action === "close") {
      method = "workspace.close";
      params = { workspace_id: args[2] };
    } else if (kind === "tab" && action === "create") {
      method = "tab.create";
      params = {
        workspace_id: argumentAfter(args, "--workspace"),
        cwd: argumentAfter(args, "--cwd"),
        label: argumentAfter(args, "--label"),
        env: environmentArguments(args),
        focus: false,
      };
    } else if (kind === "tab" && action === "rename") {
      method = "tab.rename";
      params = { tab_id: args[2], label: args[3] };
    } else if (kind === "tab" && action === "close") {
      method = "tab.close";
      params = { tab_id: args[2] };
    } else if (kind === "pane" && action === "split") {
      method = "pane.split";
      params = {
        target_pane_id: argumentAfter(args, "--pane"),
        direction: argumentAfter(args, "--direction"),
        ratio: Number(argumentAfter(args, "--ratio")),
        cwd: argumentAfter(args, "--cwd"),
        focus: false,
      };
    } else if (kind === "pane" && action === "swap") {
      method = "pane.swap";
      params = {
        source_pane_id: argumentAfter(args, "--source-pane"),
        target_pane_id: argumentAfter(args, "--target-pane"),
      };
    } else if (kind === "pane" && action === "resize") {
      method = "pane.resize";
      params = {
        pane_id: argumentAfter(args, "--pane"),
        direction: argumentAfter(args, "--direction"),
        amount: Number(argumentAfter(args, "--amount")),
      };
    } else if (kind === "pane" && action === "rename") {
      method = "pane.rename";
      params = { pane_id: args[2], label: args[3] };
    } else if (kind === "pane" && action === "close") {
      method = "pane.close";
      params = { pane_id: args[2] };
    } else if (kind === "pane" && action === "run") {
      method = "pane.send_input";
      params = { pane_id: args[2], text: args[3], keys: ["enter"] };
    } else if (kind === "pane" && action === "send-text") {
      method = "pane.send_text";
      params = { pane_id: args[2], text: args[3] };
    } else if (kind === "pane" && action === "send-keys") {
      method = "pane.send_keys";
      params = { pane_id: args[2], keys: args.slice(3) };
    } else if (kind === "agent" && action === "start") {
      const separator = args.indexOf("--");
      method = "agent.start";
      params = {
        name: args[2],
        kind: argumentAfter(args, "--kind"),
        pane_id: argumentAfter(args, "--pane"),
        timeout_ms: Number(argumentAfter(args, "--timeout")),
        args: separator < 0 ? [] : args.slice(separator + 1),
      };
    } else if (kind === "agent" && action === "prompt") {
      const waits = args.includes("--wait");
      method = "agent.prompt";
      params = {
        target: args[2],
        text: args[3],
        ...(waits
          ? {
              wait: {
                until: argumentsAfter(args, "--until"),
                timeout_ms: Number(argumentAfter(args, "--timeout")),
              },
            }
          : {}),
      };
    } else if (kind === "agent" && action === "rename") {
      method = "agent.rename";
      params = { target: args[2], name: args[3] };
    } else return this.runner.run("herdr", args, options);

    try {
      const result = await this.socketJson<unknown>(
        method,
        params,
        options.signal,
        options.timeoutMs,
      );
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ result }),
      };
    } catch (error) {
      const code = error instanceof HerdrCommandError ? error.code : undefined;
      return {
        code: 1,
        stdout: "",
        stderr: JSON.stringify({
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      };
    }
  }

  private runHerdr(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const targets = backgroundFocusTargets(args);
    const operation = () =>
      this.runner === nodeCliRunner && targets
        ? this.nativeBackgroundCommand(args, options)
        : this.runner.run("herdr", args, options);
    return targets
      ? this.backgroundMutation(targets, operation, (result) => result.stdout)
      : operation();
  }

  private async json(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const result = await this.runHerdr(args, options);
    if (result.code !== 0)
      throw commandError(args, result.stderr || result.stdout);
    return decodeJson(result.stdout, `herdr ${commandLabel(args)}`);
  }

  private async exec(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const result = await this.runHerdr(args, options);
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
    return this.backgroundMutation(
      {
        workspaceIds: [workspaceId],
        tabIds: [],
        paneIds: [],
      },
      () =>
        this.socketJson(
          "workspace.move",
          {
            workspace_id: workspaceId,
            insert_index: insertIndex,
          },
          signal,
        ),
      (result) => JSON.stringify(result),
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
    if (!pane || typeof pane.tab_id !== "string") return undefined;
    return {
      workspaceId,
      tabId: pane.tab_id,
      paneId: String(pane.pane_id),
    };
  }

  async focusedPaneId() {
    return (await this.focusedPane())?.paneId;
  }

  async closeWorkspace(workspaceId: string) {
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

  async resizePane(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
    amount: number,
  ) {
    return this.json([
      "pane",
      "resize",
      "--pane",
      paneId,
      "--direction",
      direction,
      "--amount",
      String(amount),
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
      const result = await this.runHerdr(commandArgs, {
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
