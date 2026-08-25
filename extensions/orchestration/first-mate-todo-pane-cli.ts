import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nodeCliRunner } from "./cli.ts";
import { FleetStore } from "./fleet.ts";
import {
  buildTodoBoardView,
  parseSnoozeDuration,
  reconcileTodoBoardState,
  type TodoBoardView,
} from "./first-mate-todo-model.ts";
import {
  TodoBoardStateStore,
  type ManualTodoItem,
  type PullRequestSnapshot,
} from "./first-mate-todo-state.ts";
import {
  handleTodoKey,
  normalizeUiState,
  renderTodoPane,
  type TodoUiState,
} from "./first-mate-todo-view.ts";
import { HerdrClient } from "./herdr-client.ts";

const execFileAsync = promisify(execFile);
const LOCAL_REFRESH_MS = 2_000;
const GITHUB_REFRESH_MS = 5 * 60_000;
const HELP_STATUS_MS = 5_000;
const ESC = "\u001b";
const ALT_SCREEN_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALT_SCREEN_OFF = `${ESC}[?25h${ESC}[?1049l`;
const CLEAR = `${ESC}[2J${ESC}[H`;

interface PrRefreshState {
  lastAttemptAt?: number;
  lastError?: string;
}

const stateStore = new TodoBoardStateStore();
const fleetStore = new FleetStore();
const herdr = new HerdrClient(nodeCliRunner);

let stopped = false;
let interactive = false;
let view: TodoBoardView = {
  items: [],
  generatedCount: 0,
  manualCount: 0,
  snoozedCount: 0,
  hiddenCount: 0,
  trackedPrUrls: [],
};
let uiState: TodoUiState = { showHelp: false };
let lastStatusAt = 0;
let prRefresh: PrRefreshState = {};

async function ghPullRequest(url: string): Promise<PullRequestSnapshot> {
  const result = await execFileAsync(
    "gh",
    ["pr", "view", url, "--json", "state,isDraft,title,url,reviewDecision"],
    {
      timeout: 10_000,
      env: process.env,
      maxBuffer: 512 * 1024,
    },
  );
  const value = JSON.parse(result.stdout) as {
    title?: string;
    url?: string;
    state?: string;
    isDraft?: boolean;
    reviewDecision?: string;
  };
  const state = String(value.state ?? "OPEN").toLowerCase();
  return {
    url: value.url ?? url,
    title: typeof value.title === "string" ? value.title : undefined,
    state:
      state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    draft: value.isDraft === true,
    reviewDecision:
      typeof value.reviewDecision === "string"
        ? value.reviewDecision.toLowerCase()
        : undefined,
    fetchedAt: Date.now(),
  };
}

async function boardView(now = Date.now()) {
  const state = await stateStore.read();
  const tasks = await fleetStore.listTasks();
  const [messages, focusable] = await Promise.all([
    Promise.all(
      tasks.map(
        async (task) =>
          [task.id, await fleetStore.messagesForTask(task.id)] as const,
      ),
    ),
    Promise.all(
      tasks.map(async (task) =>
        task.matePaneId &&
        task.workspaceClosedAt === undefined &&
        (task.state === "active" ||
          task.state === "waiting-decision" ||
          task.state === "blocked" ||
          task.state === "failed") &&
        (await herdr.paneExists(task.matePaneId).catch(() => false))
          ? task.id
          : undefined,
      ),
    ),
  ]);
  const result = buildTodoBoardView({
    boardState: state,
    tasks,
    messagesByTask: new Map(messages),
    focusableTaskIds: new Set(
      focusable.filter((taskId): taskId is string => taskId !== undefined),
    ),
    now,
  });
  const reconciled = reconcileTodoBoardState(state, result);
  if (reconciled !== state) {
    const originalResolutionIds = new Set(Object.keys(state.resolutions));
    const persisted = await stateStore.update((current) => {
      const next = reconcileTodoBoardState(current, result);
      const concurrentResolutions = Object.fromEntries(
        Object.entries(current.resolutions).filter(
          ([id, resolution]) =>
            /^(?:review|decision|risk|blocker|failure|outcome):/.test(id) &&
            (!originalResolutionIds.has(id) ||
              JSON.stringify(resolution) !==
                JSON.stringify(state.resolutions[id])),
        ),
      );
      return Object.keys(concurrentResolutions).length === 0
        ? next
        : {
            ...next,
            resolutions: { ...next.resolutions, ...concurrentResolutions },
          };
    });
    return buildTodoBoardView({
      boardState: persisted,
      tasks,
      messagesByTask: new Map(messages),
      focusableTaskIds: new Set(
        focusable.filter((taskId): taskId is string => taskId !== undefined),
      ),
      now,
    });
  }
  return result;
}

async function maybeRefreshPullRequests(force = false) {
  const now = Date.now();
  if (
    !force &&
    prRefresh.lastAttemptAt !== undefined &&
    now - prRefresh.lastAttemptAt < GITHUB_REFRESH_MS
  )
    return false;
  if (view.trackedPrUrls.length === 0) {
    prRefresh = { lastAttemptAt: now };
    return false;
  }
  prRefresh.lastAttemptAt = now;
  let updated = false;
  const errors: string[] = [];
  for (const url of view.trackedPrUrls) {
    try {
      const snapshot = await ghPullRequest(url);
      await stateStore.update((current) => ({
        ...current,
        pullRequests: {
          ...current.pullRequests,
          [url]: snapshot,
        },
      }));
      updated = true;
    } catch (refreshError) {
      errors.push(
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
      );
    }
  }
  prRefresh.lastError = errors.at(-1);
  return updated;
}

function setStatus(status: string | undefined) {
  uiState = { ...uiState, status };
  lastStatusAt = status ? Date.now() : 0;
}

async function refresh(forcePullRequests = false) {
  view = await boardView();
  if (forcePullRequests || view.trackedPrUrls.length > 0) {
    const changed = await maybeRefreshPullRequests(forcePullRequests);
    if (changed || forcePullRequests) view = await boardView();
  }
  uiState = normalizeUiState(view, uiState);
}

async function updateResolution(
  itemId: string,
  resolution: { state: "done" | "dismissed" | "snoozed"; until?: number },
) {
  await stateStore.update((current) => ({
    ...current,
    resolutions: {
      ...current.resolutions,
      [itemId]: { ...resolution, at: Date.now() },
    },
  }));
}

function nextManual(title: string): ManualTodoItem {
  const now = Date.now();
  return {
    id: `manual:${now}:${Math.random().toString(36).slice(2, 8)}`,
    title,
    createdAt: now,
    updatedAt: now,
  };
}

async function applyCommand(
  command: ReturnType<typeof handleTodoKey>["command"],
) {
  switch (command.type) {
    case "none":
      return;
    case "refresh":
      await refresh(true);
      setStatus(
        prRefresh.lastError
          ? `GitHub offline: ${prRefresh.lastError}`
          : "Refreshed.",
      );
      return;
    case "set-done":
      await updateResolution(command.itemId, { state: "done" });
      await refresh();
      return;
    case "dismiss":
      await updateResolution(command.itemId, { state: "dismissed" });
      await refresh();
      return;
    case "snooze": {
      const until = parseSnoozeDuration(command.value);
      if (!until) {
        setStatus("Snooze must use 30m, 1h, or 1d.");
        return;
      }
      await updateResolution(command.itemId, { state: "snoozed", until });
      await refresh();
      return;
    }
    case "add-manual":
      await stateStore.update((current) => ({
        ...current,
        manualItems: [...current.manualItems, nextManual(command.title)],
      }));
      await refresh();
      return;
    case "edit-manual":
      await stateStore.update((current) => ({
        ...current,
        manualItems: current.manualItems.map((item) =>
          item.id === command.itemId
            ? { ...item, title: command.title, updatedAt: Date.now() }
            : item,
        ),
      }));
      await refresh();
      return;
    case "focus":
      if (
        !command.item.paneId ||
        !(await herdr.paneExists(command.item.paneId).catch(() => false))
      ) {
        setStatus("Task workspace is no longer available.");
        await refresh();
        return;
      }
      try {
        await herdr.focusPane(command.item.paneId);
      } catch {
        setStatus("Task workspace is no longer available.");
        await refresh();
      }
      return;
    case "open":
      if (!command.item.prUrl) return;
      try {
        await execFileAsync("gh", ["pr", "view", command.item.prUrl, "--web"], {
          timeout: 10_000,
          env: process.env,
        });
        setStatus(`Opened ${command.item.prUrl}`);
      } catch (error) {
        setStatus(
          `Could not open browser; use ${command.item.prUrl} externally. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
  }
}

function draw() {
  if (!process.stdout.isTTY) return;
  const width = Math.max(1, process.stdout.columns || 40);
  const height = Math.max(1, process.stdout.rows || 24);
  const status =
    prRefresh.lastError && !uiState.status
      ? {
          ...uiState,
          status: `GitHub offline — using cached PR state. ${prRefresh.lastError}`,
        }
      : uiState;
  process.stdout.write(
    CLEAR + renderTodoPane(view, status, width, height).join("\n"),
  );
}

async function tick(forcePullRequests = false) {
  if (lastStatusAt && Date.now() - lastStatusAt > HELP_STATUS_MS) {
    uiState = { ...uiState, status: undefined };
    lastStatusAt = 0;
  }
  await refresh(forcePullRequests);
  draw();
}

async function onInput(data: string) {
  const result = handleTodoKey(view, uiState, data);
  uiState = result.state;
  await applyCommand(result.command);
  draw();
}

async function start() {
  if (process.argv.includes("--once")) {
    await tick(true);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("first-mate todo pane requires an interactive terminal");
  interactive = true;
  process.stdout.write(ALT_SCREEN_ON);
  await tick(true);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data: string) => {
    if (data === "\u0003") {
      void stop();
      return;
    }
    void onInput(data).catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
      draw();
    });
  });
  process.stdout.on("resize", () => draw());
  const timer = setInterval(() => {
    void tick().catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
      draw();
    });
  }, LOCAL_REFRESH_MS);
  timer.unref?.();
}

async function stop() {
  if (stopped) return;
  stopped = true;
  if (interactive && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  if (interactive && process.stdout.isTTY) process.stdout.write(ALT_SCREEN_OFF);
}

process.on("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  void stop().finally(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  void stop().finally(() => process.exit(1));
});

void start().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  void stop().finally(() => process.exit(1));
});
