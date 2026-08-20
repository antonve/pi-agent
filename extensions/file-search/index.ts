/**
 * file-search — first-class `fd` and `rg` tools for pi.
 *
 * Binary discovery and process/output modules load on first use so this
 * extension adds no subprocess probes or heavy runtime imports to Pi startup.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  buildFdArgs,
  buildRgArgs,
  FD_MAX_DEPTH_LIMIT,
  FD_MAX_LIMIT,
  RG_MAX_CONTEXT,
  RG_MAX_COUNT_LIMIT,
} from "./src/args.ts";
import {
  currentTarget,
  liveBinaryEnv,
  repositoryBinDir,
  resolveBinary,
  TOOL_SPECS,
  type BinaryEnv,
  type BinarySource,
  type PlatformTarget,
} from "./src/binaries.ts";
import type { CapturedOutput } from "./src/output.ts";
import {
  FD_PARAMETER_DESCRIPTIONS,
  FD_PROMPT_GUIDELINES,
  FD_PROMPT_SNIPPET,
  FD_TOOL_DESCRIPTION,
  RG_PARAMETER_DESCRIPTIONS,
  RG_PROMPT_GUIDELINES,
  RG_PROMPT_SNIPPET,
  RG_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

export function makeBinaryInitializers(
  binDir: string,
  target: PlatformTarget,
  env: BinaryEnv,
) {
  const cache = new Map<"fd" | "rg", ReturnType<typeof resolveBinary>>();
  const initialize = (tool: "fd" | "rg") => {
    const existing = cache.get(tool);
    if (existing) return existing;
    const pending = resolveBinary(TOOL_SPECS[tool], binDir, target, env);
    cache.set(tool, pending);
    return pending;
  };
  return {
    fd: () => initialize("fd"),
    rg: () => initialize("rg"),
  };
}

interface SearchOutcome {
  readonly output: CapturedOutput;
  readonly noMatches: boolean;
  readonly binarySource: BinarySource;
}

export interface FdToolDetails {
  readonly binarySource: BinarySource;
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface RgToolDetails {
  readonly binarySource: BinarySource;
  readonly outputLines: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

const EXEC_TIMEOUT_MS = 60_000;

type SearchRuntime = {
  executeSearchProcess: typeof import("./src/process.ts").executeSearchProcess;
  discardCapturedOutput: typeof import("./src/process.ts").discardCapturedOutput;
  formatCapturedOutput: typeof import("./src/output.ts").formatCapturedOutput;
};

let searchRuntime: Promise<SearchRuntime> | undefined;
function loadSearchRuntime() {
  return (searchRuntime ??= Promise.all([
    import("./src/process.ts"),
    import("./src/output.ts"),
  ]).then(([processModule, outputModule]) => ({
    executeSearchProcess: processModule.executeSearchProcess,
    discardCapturedOutput: processModule.discardCapturedOutput,
    formatCapturedOutput: outputModule.formatCapturedOutput,
  })));
}

export default function fileSearchTools(pi: ExtensionAPI) {
  const binDir = repositoryBinDir();
  const target = currentTarget();
  const initializers = makeBinaryInitializers(binDir, target, liveBinaryEnv);

  /** Resolve on first use, stream output to disk, and classify the exit. */
  async function runSearch(
    tool: "fd" | "rg",
    args: string[],
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error(`${tool} search was cancelled.`);
    const [binary, runtime] = await Promise.all([
      initializers[tool](),
      loadSearchRuntime(),
    ]);
    if (signal?.aborted) throw new Error(`${tool} search was cancelled.`);

    let result;
    try {
      result = await runtime.executeSearchProcess({
        command: binary.command,
        args,
        cwd: ctx.cwd,
        tempPrefix: `pi-${tool}-`,
        signal,
        timeoutMs: EXEC_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Search was cancelled.") {
        throw new Error(`${tool} search was cancelled.`);
      }
      if (message === "Search timed out.") {
        throw new Error(`${tool} timed out.`);
      }
      throw error;
    }

    // ripgrep exits 1 for "no matches"; fd exits 0 even with no results.
    if (tool === "rg" && result.code === 1 && result.output.lineCount === 0) {
      return {
        output: result.output,
        noMatches: true,
        binarySource: binary.source,
      } satisfies SearchOutcome;
    }
    if (result.code !== 0) {
      await runtime.discardCapturedOutput(result.output);
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`${tool} failed: ${detail}`);
    }
    return {
      output: result.output,
      noMatches: result.output.lineCount === 0,
      binarySource: binary.source,
    } satisfies SearchOutcome;
  }

  pi.registerTool<ReturnType<typeof fdParameters>, FdToolDetails>({
    name: "fd",
    label: "Find Files",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: fdParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch("fd", buildFdArgs(params), ctx, signal);
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: {
            binarySource: outcome.binarySource,
            matchCount: 0,
            truncated: false,
          },
        } satisfies AgentToolResult<FdToolDetails>;
      }

      const { formatCapturedOutput } = await loadSearchRuntime();
      const formatted = formatCapturedOutput(outcome.output);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          matchCount: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<FdToolDetails>;
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fd "));
      text += theme.fg("accent", args.pattern ? `"${args.pattern}"` : "(all)");
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.type && `type=${args.type}`,
        args.extension && `ext=${args.extension}`,
        args.glob && "glob",
        args.hidden && "hidden",
        args.max_depth !== undefined && `depth≤${args.max_depth}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.matchCount === 0) {
        return new Text(theme.fg("dim", "No files found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.matchCount} ${details.matchCount === 1 ? "entry" : "entries"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<ReturnType<typeof rgParameters>, RgToolDetails>({
    name: "rg",
    label: "Search Content",
    description: RG_TOOL_DESCRIPTION,
    promptSnippet: RG_PROMPT_SNIPPET,
    promptGuidelines: RG_PROMPT_GUIDELINES,
    parameters: rgParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch("rg", buildRgArgs(params), ctx, signal);
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: {
            binarySource: outcome.binarySource,
            outputLines: 0,
            truncated: false,
          },
        } satisfies AgentToolResult<RgToolDetails>;
      }

      const { formatCapturedOutput } = await loadSearchRuntime();
      const formatted = formatCapturedOutput(outcome.output);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          outputLines: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<RgToolDetails>;
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("rg "));
      text += theme.fg("accent", `"${args.pattern}"`);
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.glob && `glob=${args.glob}`,
        args.file_type && `type=${args.file_type}`,
        args.fixed_strings && "literal",
        args.hidden && "hidden",
        args.context !== undefined && `ctx=${args.context}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.outputLines === 0) {
        return new Text(theme.fg("dim", "No matches found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.outputLines} output ${details.outputLines === 1 ? "line" : "lines"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });
}

const PREVIEW_LINES = 20;

interface ThemeLike {
  fg(color: string, text: string): string;
}

function expandedPreview(
  result: { content: { type: string; text?: string }[] },
  fullOutputPath: string | undefined,
  theme: ThemeLike,
) {
  let text = "";
  const content = result.content[0];
  if (content?.type === "text" && content.text) {
    const lines = content.text.split("\n");
    for (const line of lines.slice(0, PREVIEW_LINES)) {
      text += `\n${theme.fg("dim", line)}`;
    }
    if (lines.length > PREVIEW_LINES) {
      text += `\n${theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines`)}`;
    }
  }
  if (fullOutputPath) {
    text += `\n${theme.fg("dim", `Full output: ${fullOutputPath}`)}`;
  }
  return text;
}

function fdParameters() {
  return Type.Object({
    pattern: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.pattern }),
    ),
    path: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.path }),
    ),
    type: Type.Optional(
      StringEnum(["file", "directory", "symlink"] as const, {
        description: FD_PARAMETER_DESCRIPTIONS.type,
      }),
    ),
    extension: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.extension }),
    ),
    glob: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.glob }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    max_depth: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.max_depth,
        minimum: 1,
        maximum: FD_MAX_DEPTH_LIMIT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: FD_MAX_LIMIT,
      }),
    ),
  });
}

function rgParameters() {
  return Type.Object({
    pattern: Type.String({ description: RG_PARAMETER_DESCRIPTIONS.pattern }),
    path: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.path }),
    ),
    glob: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.glob }),
    ),
    file_type: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.file_type }),
    ),
    case_sensitive: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.case_sensitive }),
    ),
    fixed_strings: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.fixed_strings }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    context: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.context,
        minimum: 0,
        maximum: RG_MAX_CONTEXT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: RG_MAX_COUNT_LIMIT,
      }),
    ),
  });
}
