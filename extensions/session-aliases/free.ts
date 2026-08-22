import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  SessionManager,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const ABORT = "Abort";
const FORCE_CLEAN = "Force clean lease";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult>;
}

export interface TreehouseLeaseContext {
  path: string;
  leaseId: string;
  originalRepository: string;
  dirty: boolean;
}

export interface HerdrRename {
  tabId: string;
  label: string;
}

export interface FreeReplacementContext {
  ui: Pick<ExtensionCommandContext["ui"], "notify">;
}

export interface FreeDependencies {
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  createEmptySession(cwd: string): Promise<string>;
  chdir(cwd: string): void;
}

export const nodeCommandRunner: CommandRunner = {
  async run(command, args, options = {}) {
    try {
      const result = await execFileAsync(command, [...args], {
        cwd: options.cwd,
        env: process.env,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 4 * 1024 * 1024,
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

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function outputError(result: CommandResult, fallback: string) {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

export function nextFreeLabel(tabListOutput: string) {
  const value = parseJson(tabListOutput);
  const result =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).result
      : undefined;
  const tabs =
    result && typeof result === "object" && !Array.isArray(result)
      ? records((result as Record<string, unknown>).tabs)
      : [];
  const highest = tabs.reduce((maximum, tab) => {
    const match =
      typeof tab.label === "string" ? /^free-(\d+)$/.exec(tab.label) : null;
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, -1);
  return `free-${highest + 1}`;
}

function firstWorktree(output: string) {
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) return field.slice("worktree ".length);
  }
  return undefined;
}

export async function discoverTreehouseLease(
  cwd: string,
  runner: CommandRunner,
): Promise<TreehouseLeaseContext | undefined> {
  const repository = await runner.run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  if (repository.code !== 0 || !repository.stdout.trim()) return undefined;
  const repositoryRoot = resolve(repository.stdout.trim());

  const status = await runner.run("treehouse", ["status", "--json"], {
    cwd: repositoryRoot,
  });
  if (status.code !== 0) return undefined;
  const lease = records(parseJson(status.stdout)).find(
    (entry) =>
      entry.status === "leased" &&
      typeof entry.path === "string" &&
      resolve(entry.path) === repositoryRoot &&
      typeof entry.lease_id === "string" &&
      entry.lease_id.length > 0,
  );
  if (!lease) return undefined;

  const worktrees = await runner.run(
    "git",
    ["worktree", "list", "--porcelain", "-z"],
    { cwd: repositoryRoot },
  );
  const originalRepository =
    worktrees.code === 0 ? firstWorktree(worktrees.stdout) : undefined;
  if (!originalRepository)
    throw new Error(
      outputError(
        worktrees,
        "Could not locate the repository's main worktree.",
      ),
    );

  const changes = await runner.run(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: repositoryRoot },
  );
  if (changes.code !== 0)
    throw new Error(outputError(changes, "Could not inspect lease changes."));

  return {
    path: repositoryRoot,
    leaseId: lease.lease_id as string,
    originalRepository: resolve(originalRepository),
    dirty: changes.stdout.trim().length > 0,
  };
}

export async function prepareHerdrRename(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<HerdrRename | undefined> {
  if (env.HERDR_ENV !== "1" || !env.HERDR_TAB_ID || !env.HERDR_WORKSPACE_ID)
    return undefined;
  const tabs = await runner.run("herdr", [
    "tab",
    "list",
    "--workspace",
    env.HERDR_WORKSPACE_ID,
  ]);
  if (tabs.code !== 0)
    throw new Error(outputError(tabs, "Could not list Herdr tabs."));
  return {
    tabId: env.HERDR_TAB_ID,
    label: nextFreeLabel(tabs.stdout),
  };
}

export async function createEmptySession(cwd: string) {
  const manager = SessionManager.create(cwd);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Could not allocate a new session file.");
  const content = `${manager
    .getEntries()
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  await writeFile(sessionFile, content, { flag: "wx", mode: 0o600 });
  return sessionFile;
}

async function finishFree(
  ctx: FreeReplacementContext,
  rename: HerdrRename | undefined,
  runner: CommandRunner,
  lease?: TreehouseLeaseContext,
) {
  if (lease) {
    const returned = await runner.run(
      "treehouse",
      ["return", lease.path, "--force", "--if-lease-id", lease.leaseId],
      { cwd: lease.originalRepository },
    );
    if (returned.code !== 0)
      ctx.ui.notify(
        outputError(returned, "Treehouse lease return failed."),
        "error",
      );
  }
  if (rename) {
    const renamed = await runner.run("herdr", [
      "tab",
      "rename",
      rename.tabId,
      rename.label,
    ]);
    if (renamed.code !== 0)
      ctx.ui.notify(outputError(renamed, "Herdr tab rename failed."), "error");
  }
}

export async function runFree(
  ctx: ExtensionCommandContext,
  dependencies: FreeDependencies,
) {
  const lease = await discoverTreehouseLease(ctx.cwd, dependencies.runner);
  if (lease?.dirty) {
    if (!ctx.hasUI) return;
    const choice = await ctx.ui.select(
      "Treehouse lease has uncommitted changes",
      [ABORT, FORCE_CLEAN],
    );
    if (choice !== FORCE_CLEAN) return;
  }

  const rename = await prepareHerdrRename(
    dependencies.runner,
    dependencies.env,
  );
  if (!lease) {
    await ctx.newSession({
      withSession: (replacementCtx) =>
        finishFree(replacementCtx, rename, dependencies.runner),
    });
    return;
  }

  const targetSession = await dependencies.createEmptySession(
    lease.originalRepository,
  );
  const result = await ctx.switchSession(targetSession, {
    withSession: async (replacementCtx) => {
      dependencies.chdir(lease.originalRepository);
      await finishFree(replacementCtx, rename, dependencies.runner, lease);
    },
  });
  if (result.cancelled) await unlink(targetSession).catch(() => undefined);
}
