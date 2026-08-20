import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  readonly probe: (command: string, tool: ToolName) => Promise<boolean>;
}

export interface ResolvedBinary {
  readonly tool: ToolName;
  readonly command: string;
  readonly source: BinarySource;
}

export class BinaryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryUnavailableError";
  }
}

export function currentTarget(): PlatformTarget {
  return { os: process.platform, arch: process.arch };
}

/** Kept for callers/tests; this setup never stores or downloads fallback binaries. */
export function repositoryBinDir() {
  return "";
}

export async function resolveBinary(
  spec: ToolSpec,
  _binDir: string,
  _target: PlatformTarget,
  env: BinaryEnv,
): Promise<ResolvedBinary> {
  for (const command of spec.systemCommands) {
    if (await env.probe(command, spec.tool)) {
      return { tool: spec.tool, command, source: "system" };
    }
  }
  throw new BinaryUnavailableError(
    `${spec.tool} is unavailable on PATH. Install it through the system/Home Manager configuration and restart Pi.`,
  );
}

export const liveBinaryEnv: BinaryEnv = {
  probe: async (command) => {
    try {
      await execFileAsync(command, ["--version"], {
        timeout: 5_000,
        env: process.env,
      });
      return true;
    } catch {
      return false;
    }
  },
};
