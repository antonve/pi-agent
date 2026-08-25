import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDirectory } from "./registry.ts";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export interface ManualTodoItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface TodoResolution {
  state: "done" | "dismissed" | "snoozed";
  at: number;
  until?: number;
}

export interface PullRequestSnapshot {
  url: string;
  title?: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  reviewDecision?: string;
  fetchedAt: number;
}

export type TodoHistoryItemKind =
  | "review"
  | "decision"
  | "risk"
  | "blocker"
  | "failure"
  | "outcome"
  | "manual";

export type TodoHistoryStatus =
  | "done"
  | "dismissed"
  | "acknowledged"
  | "completed"
  | "resolved"
  | "closed"
  | "merged";

export interface TodoHistoryItem {
  id: string;
  source: "generated" | "manual";
  kind: TodoHistoryItemKind;
  title: string;
  taskId?: string;
  taskTitle?: string;
  detail?: string;
  status: TodoHistoryStatus;
  prUrl?: string;
  resolvedAt: number;
}

export interface TodoBoardState {
  version: 1;
  manualItems: ManualTodoItem[];
  resolutions: Record<string, TodoResolution>;
  pullRequests: Record<string, PullRequestSnapshot>;
  historyItems?: TodoHistoryItem[];
  dismissedRiskIds?: string[];
}

export interface TodoPaneRuntimeState {
  version: 1;
  paneId?: string;
  parentPaneId?: string;
  tabId?: string;
  workspaceId?: string;
  startedAt?: number;
  fingerprint?: string;
}

function isErrno(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function todoDirectory() {
  return join(stateDirectory(), "first-mate-todo");
}

function emptyBoardState(): TodoBoardState {
  return {
    version: 1,
    manualItems: [],
    resolutions: {},
    pullRequests: {},
    historyItems: [],
    dismissedRiskIds: [],
  };
}

function emptyRuntimeState(): TodoPaneRuntimeState {
  return { version: 1 };
}

class LockedJsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  private readonly empty: () => T;
  private readonly normalize: (value: unknown) => T;

  constructor(path: string, empty: () => T, normalize: (value: unknown) => T) {
    this.path = path;
    this.empty = empty;
    this.normalize = normalize;
  }

  private async readUnlocked() {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return this.empty();
      throw error;
    }
    try {
      return this.normalize(JSON.parse(contents));
    } catch (error) {
      throw new Error(`Invalid first-mate to-do state at ${this.path}.`, {
        cause: error,
      });
    }
  }

  private async writeUnlocked(value: T) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }

  private async withFileLock<TValue>(operation: () => Promise<TValue>) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`);
          return await operation();
        } finally {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch (statError) {
          if (isErrno(statError, "ENOENT")) continue;
          throw statError;
        }
        if (Date.now() >= deadline)
          throw new Error(`Timed out acquiring lock for ${this.path}.`);
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private serialize<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    const locked = () => this.withFileLock(operation);
    const result = this.queue.then(locked, locked);
    this.queue = result.catch(() => undefined);
    return result;
  }

  read() {
    return this.serialize(() => this.readUnlocked());
  }

  write(value: T) {
    return this.serialize(async () => {
      await this.writeUnlocked(value);
      return value;
    });
  }

  update(mutator: (current: T) => T) {
    return this.serialize(async () => {
      const updated = mutator(await this.readUnlocked());
      await this.writeUnlocked(updated);
      return updated;
    });
  }
}

function normalizeManualItem(value: unknown): ManualTodoItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.title === "string"
    ? {
        id: record.id,
        title: record.title,
        createdAt:
          typeof record.createdAt === "number" ? record.createdAt : Date.now(),
        updatedAt:
          typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
      }
    : undefined;
}

function normalizeResolution(value: unknown): TodoResolution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    (record.state !== "done" &&
      record.state !== "dismissed" &&
      record.state !== "snoozed") ||
    typeof record.at !== "number"
  )
    return undefined;
  return {
    state: record.state,
    at: record.at,
    until: typeof record.until === "number" ? record.until : undefined,
  };
}

function normalizeHistoryItem(value: unknown): TodoHistoryItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kinds = new Set<TodoHistoryItemKind>([
    "review",
    "decision",
    "risk",
    "blocker",
    "failure",
    "outcome",
    "manual",
  ]);
  const statuses = new Set<TodoHistoryStatus>([
    "done",
    "dismissed",
    "acknowledged",
    "completed",
    "resolved",
    "closed",
    "merged",
  ]);
  if (
    typeof record.id !== "string" ||
    (record.source !== "generated" && record.source !== "manual") ||
    typeof record.kind !== "string" ||
    !kinds.has(record.kind as TodoHistoryItemKind) ||
    typeof record.title !== "string" ||
    typeof record.status !== "string" ||
    !statuses.has(record.status as TodoHistoryStatus) ||
    typeof record.resolvedAt !== "number"
  )
    return undefined;
  return {
    id: record.id,
    source: record.source,
    kind: record.kind as TodoHistoryItemKind,
    title: record.title,
    taskId: typeof record.taskId === "string" ? record.taskId : undefined,
    taskTitle:
      typeof record.taskTitle === "string" ? record.taskTitle : undefined,
    detail: typeof record.detail === "string" ? record.detail : undefined,
    status: record.status as TodoHistoryStatus,
    prUrl: typeof record.prUrl === "string" ? record.prUrl : undefined,
    resolvedAt: record.resolvedAt,
  };
}

function normalizePullRequest(value: unknown): PullRequestSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.url !== "string" ||
    typeof record.state !== "string" ||
    typeof record.draft !== "boolean" ||
    typeof record.fetchedAt !== "number"
  )
    return undefined;
  const state =
    record.state === "open" ||
    record.state === "closed" ||
    record.state === "merged"
      ? record.state
      : undefined;
  if (!state) return undefined;
  return {
    url: record.url,
    title: typeof record.title === "string" ? record.title : undefined,
    state,
    draft: record.draft,
    reviewDecision:
      typeof record.reviewDecision === "string"
        ? record.reviewDecision
        : undefined,
    fetchedAt: record.fetchedAt,
  };
}

function normalizeBoardState(value: unknown): TodoBoardState {
  if (!value || typeof value !== "object") return emptyBoardState();
  const record = value as Record<string, unknown>;
  const manualItems = Array.isArray(record.manualItems)
    ? record.manualItems
        .map((item) => normalizeManualItem(item))
        .filter((item) => item !== undefined)
    : [];
  const resolutions =
    record.resolutions && typeof record.resolutions === "object"
      ? Object.fromEntries(
          Object.entries(record.resolutions as Record<string, unknown>)
            .map(
              ([key, resolution]) =>
                [key, normalizeResolution(resolution)] as const,
            )
            .filter(
              (entry): entry is [string, TodoResolution] =>
                entry[1] !== undefined,
            ),
        )
      : {};
  const pullRequests =
    record.pullRequests && typeof record.pullRequests === "object"
      ? Object.fromEntries(
          Object.entries(record.pullRequests as Record<string, unknown>)
            .map(
              ([key, snapshot]) =>
                [key, normalizePullRequest(snapshot)] as const,
            )
            .filter(
              (entry): entry is [string, PullRequestSnapshot] =>
                entry[1] !== undefined,
            ),
        )
      : {};
  const historyItems = Array.isArray(record.historyItems)
    ? record.historyItems
        .map((item) => normalizeHistoryItem(item))
        .filter((item) => item !== undefined)
    : [];
  const dismissedRiskIds = new Set(
    Array.isArray(record.dismissedRiskIds)
      ? record.dismissedRiskIds.filter(
          (id): id is string =>
            typeof id === "string" && id.startsWith("risk:"),
        )
      : [],
  );
  for (const [id, resolution] of Object.entries(resolutions))
    if (id.startsWith("risk:") && resolution.state === "dismissed")
      dismissedRiskIds.add(id);
  for (const item of historyItems)
    if (
      item.kind === "risk" &&
      item.status === "dismissed" &&
      item.id.startsWith("risk:")
    )
      dismissedRiskIds.add(item.id);
  return {
    version: 1,
    manualItems,
    resolutions,
    pullRequests,
    historyItems,
    dismissedRiskIds: [...dismissedRiskIds].sort(),
  };
}

function normalizeRuntimeState(value: unknown): TodoPaneRuntimeState {
  if (!value || typeof value !== "object") return emptyRuntimeState();
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    paneId: typeof record.paneId === "string" ? record.paneId : undefined,
    parentPaneId:
      typeof record.parentPaneId === "string" ? record.parentPaneId : undefined,
    tabId: typeof record.tabId === "string" ? record.tabId : undefined,
    workspaceId:
      typeof record.workspaceId === "string" ? record.workspaceId : undefined,
    startedAt:
      typeof record.startedAt === "number" ? record.startedAt : undefined,
    fingerprint:
      typeof record.fingerprint === "string" ? record.fingerprint : undefined,
  };
}

export class TodoBoardStateStore {
  private readonly store: LockedJsonStore<TodoBoardState>;

  constructor(path = join(todoDirectory(), "board.json")) {
    this.store = new LockedJsonStore(
      path,
      emptyBoardState,
      normalizeBoardState,
    );
  }

  get path() {
    return this.store.path;
  }

  read() {
    return this.store.read();
  }

  write(value: TodoBoardState) {
    return this.store.write(value);
  }

  update(mutator: (current: TodoBoardState) => TodoBoardState) {
    return this.store.update(mutator);
  }
}

export class TodoPaneRuntimeStore {
  private readonly store: LockedJsonStore<TodoPaneRuntimeState>;

  constructor(path = join(todoDirectory(), "runtime.json")) {
    this.store = new LockedJsonStore(
      path,
      emptyRuntimeState,
      normalizeRuntimeState,
    );
  }

  get path() {
    return this.store.path;
  }

  read() {
    return this.store.read();
  }

  write(value: TodoPaneRuntimeState) {
    return this.store.write(value);
  }
}
