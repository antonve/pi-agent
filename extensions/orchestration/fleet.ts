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

export const FLEET_MESSAGE_TYPES = [
  "TASK_ASSIGNED",
  "TASK_ACCEPTED",
  "DECISION_REQUEST",
  "DECISION_RESPONSE",
  "SCOPE_UPDATE",
  "PRIORITY_UPDATE",
  "MATERIAL_RISK",
  "TASK_BLOCKED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "PAUSE",
  "RESUME",
  "CANCEL",
] as const;
export type FleetMessageType = (typeof FLEET_MESSAGE_TYPES)[number];

export type FleetTaskState =
  | "proposed"
  | "assigning"
  | "assigned"
  | "active"
  | "waiting-decision"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface FirstMateLease {
  sessionId: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  claimedAt: number;
  updatedAt: number;
  lostAt?: number;
}

export interface FleetTask {
  id: string;
  title: string;
  brief: string;
  cwd: string;
  state: FleetTaskState;
  ownerSessionId: string;
  ownerPaneId?: string;
  mateSessionId?: string;
  workspaceId?: string;
  mateTabId?: string;
  matePaneId?: string;
  mateAgentName?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  nextSequence: number;
  cleanupAt?: number;
  workspaceClosedAt?: number;
  pinned?: boolean;
  error?: string;
}

export interface FleetMessage {
  id: string;
  taskId: string;
  type: FleetMessageType;
  fromSessionId: string;
  toSessionId?: string;
  toTaskMate?: boolean;
  sequence: number;
  createdAt: number;
  payload: Record<string, unknown>;
  requiresAck: boolean;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  disposition?: "accepted" | "duplicate" | "rejected";
  rejectionReason?: string;
}

interface FleetState {
  version: 1;
  firstMate?: FirstMateLease;
  tasks: FleetTask[];
  messages: FleetMessage[];
}

function emptyState(): FleetState {
  return { version: 1, tasks: [], messages: [] };
}

const FIRST_MATE_INBOUND_TYPES = new Set<FleetMessageType>([
  "TASK_ACCEPTED",
  "DECISION_REQUEST",
  "MATERIAL_RISK",
  "TASK_BLOCKED",
  "TASK_COMPLETED",
  "TASK_FAILED",
]);

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

export class FleetStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;

  constructor(path = join(stateDirectory(), "fleet.json")) {
    this.path = path;
  }

  private async readUnlocked(): Promise<FleetState> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyState();
      throw error;
    }
    let value: FleetState;
    try {
      value = JSON.parse(contents) as FleetState;
    } catch (error) {
      throw new Error(`Invalid first-mate fleet store at ${this.path}.`, {
        cause: error,
      });
    }
    if (
      value.version !== 1 ||
      !Array.isArray(value.tasks) ||
      !Array.isArray(value.messages)
    )
      throw new Error(`Unsupported first-mate fleet store at ${this.path}.`);
    return value;
  }

  private async writeUnlocked(state: FleetState) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }

  private async withFileLock<T>(operation: () => Promise<T>) {
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
          throw new Error("Timed out acquiring first-mate fleet lock.");
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const locked = () => this.withFileLock(operation);
    const result = this.queue.then(locked, locked);
    this.queue = result.catch(() => undefined);
    return result;
  }

  getFirstMate() {
    return this.serialize(async () => (await this.readUnlocked()).firstMate);
  }

  claimFirstMate(options: {
    sessionId: string;
    workspaceId: string;
    tabId: string;
    paneId: string;
    expectedSessionId?: string;
  }) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      if (state.firstMate?.sessionId !== options.expectedSessionId)
        throw new Error("First-mate ownership changed while claiming it.");
      const now = Date.now();
      const previousOwners = new Set(
        state.tasks.map((task) => task.ownerSessionId),
      );
      const sameSession = state.firstMate?.sessionId === options.sessionId;
      const replayIds = new Set<string>();
      if (!sameSession) {
        for (const task of state.tasks) {
          const replayType: FleetMessageType | undefined =
            task.state === "waiting-decision"
              ? "DECISION_REQUEST"
              : task.state === "blocked"
                ? "TASK_BLOCKED"
                : task.state === "failed"
                  ? "TASK_FAILED"
                  : task.state === "completed"
                    ? "TASK_COMPLETED"
                    : task.state === "active"
                      ? "MATERIAL_RISK"
                      : undefined;
          if (!replayType) continue;
          const latest = [...state.messages]
            .reverse()
            .find(
              (message) =>
                message.taskId === task.id && message.type === replayType,
            );
          if (latest) replayIds.add(latest.id);
        }
      }
      const lease: FirstMateLease = {
        sessionId: options.sessionId,
        workspaceId: options.workspaceId,
        tabId: options.tabId,
        paneId: options.paneId,
        claimedAt: sameSession ? state.firstMate!.claimedAt : now,
        updatedAt: now,
      };
      state.firstMate = lease;
      state.tasks = state.tasks.map((task) => ({
        ...task,
        ownerSessionId: options.sessionId,
        ownerPaneId: options.paneId,
        version: task.version + 1,
        updatedAt: now,
      }));
      state.messages = state.messages.map((message) => {
        const inboundForPreviousOwner =
          message.toSessionId !== undefined &&
          previousOwners.has(message.toSessionId) &&
          FIRST_MATE_INBOUND_TYPES.has(message.type);
        if (
          !inboundForPreviousOwner ||
          (message.acknowledgedAt !== undefined && !replayIds.has(message.id))
        )
          return message;
        return {
          ...message,
          toSessionId: options.sessionId,
          acknowledgedAt: undefined,
          acknowledgedBy: undefined,
          disposition: undefined,
          rejectionReason: undefined,
        };
      });
      await this.writeUnlocked(state);
      return lease;
    });
  }

  touchFirstMate(sessionId: string, now = Date.now()) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      if (!state.firstMate || state.firstMate.sessionId !== sessionId)
        return state.firstMate;
      if (now - state.firstMate.updatedAt < 5_000) return state.firstMate;
      const { lostAt: _lostAt, ...lease } = state.firstMate;
      state.firstMate = { ...lease, updatedAt: now };
      await this.writeUnlocked(state);
      return state.firstMate;
    });
  }

  markFirstMateLost(sessionId: string, now = Date.now()) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      if (!state.firstMate || state.firstMate.sessionId !== sessionId)
        return state.firstMate;
      if (state.firstMate.lostAt !== undefined) return state.firstMate;
      state.firstMate = { ...state.firstMate, lostAt: now, updatedAt: now };
      await this.writeUnlocked(state);
      return state.firstMate;
    });
  }

  clearFirstMateLost(sessionId: string, now = Date.now()) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      if (
        !state.firstMate ||
        state.firstMate.sessionId !== sessionId ||
        state.firstMate.lostAt === undefined
      )
        return state.firstMate;
      const { lostAt: _lostAt, ...lease } = state.firstMate;
      state.firstMate = { ...lease, updatedAt: now };
      await this.writeUnlocked(state);
      return state.firstMate;
    });
  }

  listTasks() {
    return this.serialize(async () => (await this.readUnlocked()).tasks);
  }

  async getTask(id: string) {
    return (await this.listTasks()).find((task) => task.id === id);
  }

  createTask(
    task: Omit<
      FleetTask,
      "createdAt" | "updatedAt" | "version" | "nextSequence"
    >,
  ) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      if (state.tasks.some((candidate) => candidate.id === task.id))
        throw new Error(`Fleet task ${task.id} already exists.`);
      const now = Date.now();
      const created: FleetTask = {
        ...task,
        createdAt: now,
        updatedAt: now,
        version: 1,
        nextSequence: 1,
      };
      state.tasks.push(created);
      await this.writeUnlocked(state);
      return created;
    });
  }

  updateTask(id: string, patch: Partial<FleetTask>, expectedVersion?: number) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      const index = state.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error(`Unknown fleet task ${id}.`);
      const current = state.tasks[index]!;
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        throw new Error(
          `Fleet task ${id} changed concurrently (expected version ${expectedVersion}, found ${current.version}).`,
        );
      const updated: FleetTask = {
        ...current,
        ...patch,
        id: current.id,
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      state.tasks[index] = updated;
      await this.writeUnlocked(state);
      return updated;
    });
  }

  enqueue(options: {
    taskId: string;
    type: FleetMessageType;
    fromSessionId: string;
    toSessionId?: string;
    toTaskMate?: boolean;
    payload?: Record<string, unknown>;
    requiresAck?: boolean;
  }) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      const taskIndex = state.tasks.findIndex(
        (task) => task.id === options.taskId,
      );
      if (taskIndex < 0)
        throw new Error(`Unknown fleet task ${options.taskId}.`);
      const task = state.tasks[taskIndex]!;
      const message: FleetMessage = {
        id: randomUUID(),
        taskId: task.id,
        type: options.type,
        fromSessionId: options.fromSessionId,
        toSessionId: options.toSessionId,
        toTaskMate: options.toTaskMate,
        sequence: task.nextSequence,
        createdAt: Date.now(),
        payload: options.payload ?? {},
        requiresAck: options.requiresAck ?? true,
      };
      state.messages.push(message);
      state.tasks[taskIndex] = {
        ...task,
        nextSequence: task.nextSequence + 1,
        version: task.version + 1,
        updatedAt: Date.now(),
      };
      await this.writeUnlocked(state);
      return message;
    });
  }

  pendingFor(sessionId: string, mateTaskId?: string) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      return state.messages
        .filter(
          (message) =>
            message.acknowledgedAt === undefined &&
            (message.toSessionId === sessionId ||
              (mateTaskId !== undefined &&
                message.taskId === mateTaskId &&
                message.toTaskMate === true)),
        )
        .sort((left, right) =>
          left.taskId === right.taskId
            ? left.sequence - right.sequence
            : left.createdAt - right.createdAt,
        );
    });
  }

  acknowledge(
    messageId: string,
    receiver: string,
    disposition: FleetMessage["disposition"] = "accepted",
    reason?: string,
  ) {
    return this.serialize(async () => {
      const state = await this.readUnlocked();
      const index = state.messages.findIndex(
        (message) => message.id === messageId,
      );
      if (index < 0) throw new Error(`Unknown fleet message ${messageId}.`);
      const current = state.messages[index]!;
      if (current.acknowledgedAt !== undefined) return current;
      const updated: FleetMessage = {
        ...current,
        acknowledgedAt: Date.now(),
        acknowledgedBy: receiver,
        disposition,
        rejectionReason: reason,
      };
      state.messages[index] = updated;
      await this.writeUnlocked(state);
      return updated;
    });
  }

  messagesForTask(taskId: string) {
    return this.serialize(async () =>
      (await this.readUnlocked()).messages
        .filter((message) => message.taskId === taskId)
        .sort((left, right) => left.sequence - right.sequence),
    );
  }
}
