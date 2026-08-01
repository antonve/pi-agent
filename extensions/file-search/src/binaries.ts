import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Data, Effect } from "effect";

const execFileAsync = promisify(execFile);

export type ToolName = "fd" | "rg";
export type BinarySource = "system";

export interface ToolSpec {
  readonly tool: ToolName;
  readonly systemCommands: readonly string[];
  readonly binaryName: string;
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  fd: { tool: "fd", systemCommands: ["fd", "fdfind"], binaryName: "fd" },
  rg: { tool: "rg", systemCommands: ["rg"], binaryName: "rg" },
};

export interface PlatformTarget {
  readonly os: string;
  readonly arch: string;
}

export interface BinaryEnv {
  readonly probe: (command: string, tool: ToolName) => Effect.Effect<boolean>;
}

export interface ResolvedBinary {
  readonly tool: ToolName;
  readonly command: string;
  readonly source: BinarySource;
}

export class BinaryUnavailableError extends Data.TaggedError(
  "BinaryUnavailableError",
)<{
  readonly message: string;
}> {}

export function currentTarget(): PlatformTarget {
  return { os: process.platform, arch: process.arch };
}

/** Kept for callers/tests; this setup never stores or downloads fallback binaries. */
export function repositoryBinDir() {
  return "";
}

export function resolveBinary(
  spec: ToolSpec,
  _binDir: string,
  _target: PlatformTarget,
  env: BinaryEnv,
): Effect.Effect<ResolvedBinary, BinaryUnavailableError> {
  return Effect.gen(function* () {
    for (const command of spec.systemCommands) {
      if (yield* env.probe(command, spec.tool)) {
        return { tool: spec.tool, command, source: "system" as const };
      }
    }
    return yield* new BinaryUnavailableError({
      message: `${spec.tool} is unavailable on PATH. Install it through the system/Home Manager configuration and restart Pi.`,
    });
  });
}

export const liveBinaryEnv: BinaryEnv = {
  probe: (command, tool) =>
    Effect.promise(async () => {
      try {
        await execFileAsync(
          command,
          tool === "fd" ? ["--version"] : ["--version"],
          {
            timeout: 5_000,
            env: process.env,
          },
        );
        return true;
      } catch {
        return false;
      }
    }),
};
