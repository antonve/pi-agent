import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskRecord } from "./domain.ts";

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

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
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
}
