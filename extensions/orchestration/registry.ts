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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskRecord } from "./domain.ts";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

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

export function stateDirectory() {
  return (
    process.env.PI_HERDR_STATE_DIR ??
    join(homedir(), ".local", "state", "pi-herdr")
  );
}

export class TaskRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;

  constructor(path = join(stateDirectory(), "registry.json")) {
    this.path = path;
  }

  private async readUnlocked(): Promise<TaskRecord[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return Array.isArray(value) ? (value as TaskRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async writeUnlocked(tasks: TaskRecord[]) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(tasks, null, 2)}\n`, {
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
          throw new Error(`Timed out acquiring orchestration registry lock.`);
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

  list() {
    return this.serialize(() => this.readUnlocked());
  }
  async get(id: string) {
    return (await this.list()).find((task) => task.id === id);
  }
  put(task: TaskRecord) {
    return this.serialize(async () => {
      const tasks = await this.readUnlocked();
      const index = tasks.findIndex((candidate) => candidate.id === task.id);
      if (index < 0) tasks.push(task);
      else tasks[index] = task;
      await this.writeUnlocked(tasks);
      return task;
    });
  }
  update(id: string, patch: Partial<TaskRecord>) {
    return this.serialize(async () => {
      const tasks = await this.readUnlocked();
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error(`Unknown orchestration task ${id}`);
      const task = { ...tasks[index]!, ...patch, updatedAt: Date.now() };
      tasks[index] = task;
      await this.writeUnlocked(tasks);
      return task;
    });
  }
  transition(
    id: string,
    expected: TaskRecord["status"][],
    patch: Partial<TaskRecord>,
  ) {
    return this.serialize(async () => {
      const tasks = await this.readUnlocked();
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error(`Unknown orchestration task ${id}`);
      const current = tasks[index]!;
      if (!expected.includes(current.status)) return undefined;
      const task = { ...current, ...patch, updatedAt: Date.now() };
      tasks[index] = task;
      await this.writeUnlocked(tasks);
      return task;
    });
  }
  pruneClosedBefore(cutoff: number) {
    return this.serialize(async () => {
      const tasks = await this.readUnlocked();
      const retained = tasks.filter(
        (task) =>
          task.resourceClosedAt === undefined ||
          task.resourceClosedAt >= cutoff,
      );
      if (retained.length !== tasks.length) await this.writeUnlocked(retained);
      return tasks.length - retained.length;
    });
  }
}
