import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CliRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CliResult>;
}

export const nodeCliRunner: CliRunner = {
  async run(command, args, options = {}) {
    try {
      const result = await execFileAsync(command, [...args], {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        code: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
};

export function decodeJson(text: string, command: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${command} returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

export function findString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys)
    if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findString(item, keys);
        if (found) return found;
      }
    } else {
      const found = findString(child, keys);
      if (found) return found;
    }
  }
  return undefined;
}

export function findObjects(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const output: Record<string, unknown>[] = [];
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) return candidate.forEach(visit);
    const record = candidate as Record<string, unknown>;
    if (predicate(record)) output.push(record);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return output;
}
