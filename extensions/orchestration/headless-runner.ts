import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { Harness, TaskStatus } from "./domain.ts";
import {
  buildHeadlessHarnessLaunch,
  extractHarnessSessionId,
  extractStructuredText,
  type HeadlessHarnessLaunch,
  type HeadlessHarnessOptions,
} from "./harnesses.ts";
import { stateDirectory } from "./registry.ts";

export const HEADLESS_STARTUP_TIMEOUT_MS = 30_000;

export interface HeadlessRunArtifacts {
  directory: string;
  promptPath: string;
  outputPath: string;
  exitStatusPath: string;
  lastMessagePath: string;
  pidPath: string;
  scriptPath: string;
}

async function resolveExecutable(command: string) {
  if (isAbsolute(command)) return command;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Headless harness executable not found: ${command}`);
}

export interface ParsedLeafOutcome {
  status: Extract<TaskStatus, "done" | "failed" | "blocked">;
  report: string;
  sessionId?: string;
  exitCode: number;
}

export async function prepareHeadlessRun(options: {
  taskId: string;
  turn: number;
  prompt: string;
  harness: Omit<HeadlessHarnessOptions, "resultPath">;
}) {
  const directory = join(
    stateDirectory(),
    "runs",
    options.taskId,
    String(options.turn),
  );
  const artifacts: HeadlessRunArtifacts = {
    directory,
    promptPath: join(directory, "prompt.txt"),
    outputPath: join(directory, "output.jsonl"),
    exitStatusPath: join(directory, "exit-status"),
    lastMessagePath: join(directory, "last-message.txt"),
    pidPath: join(directory, "pid"),
    scriptPath: join(directory, "run.mjs"),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const guardBin = join(directory, "guard-bin");
  await mkdir(guardBin, { recursive: true, mode: 0o700 });
  for (const command of [
    "herdr",
    "treehouse",
    "pi",
    "claude",
    "codex",
    "opencode",
  ])
    await writeFile(
      join(guardBin, command),
      "#!/bin/sh\necho 'Managed leaf workers cannot launch agents or control orchestration resources.' >&2\nexit 64\n",
      { mode: 0o700 },
    );
  await writeFile(artifacts.promptPath, options.prompt, { mode: 0o600 });
  const launch = buildHeadlessHarnessLaunch({
    ...options.harness,
    resultPath: artifacts.lastMessagePath,
  });
  launch.command = await resolveExecutable(launch.command);
  await writeFile(
    artifacts.scriptPath,
    buildHeadlessScript(launch, artifacts),
    { mode: 0o700 },
  );
  return { launch, artifacts };
}

export function buildHeadlessScript(
  launch: HeadlessHarnessLaunch,
  artifacts: HeadlessRunArtifacts,
) {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";

const command = ${JSON.stringify(launch.command)};
const args = ${JSON.stringify(launch.args)};
const prompt = await readFile(${JSON.stringify(artifacts.promptPath)}, "utf8");
if (${JSON.stringify(launch.promptDelivery)} === "argument") args.push(prompt);
const environment = {
  ...process.env,
  PI_FIRST_MATE_ROLE: "leaf",
  HERDR_SOCKET_PATH: ${JSON.stringify(`${artifacts.directory}/guard-bin/no-herdr.sock`)},
  PATH: ${JSON.stringify(`${artifacts.directory}/guard-bin:`)} + (process.env.PATH ?? ""),
  ${launch.kind === "opencode" ? `OPENCODE_PERMISSION: ${JSON.stringify(JSON.stringify({ task: "deny" }))},` : ""}
};
delete environment.PI_FIRST_MATE_TASK_ID;
delete environment.PI_FIRST_MATE_OWNER_SESSION_ID;
delete environment.HERDR_PANE_ID;
delete environment.HERDR_TAB_ID;
delete environment.HERDR_WORKSPACE_ID;

const output = createWriteStream(${JSON.stringify(artifacts.outputPath)}, {
  flags: "w",
  mode: 0o600,
});
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: environment,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});
if (child.pid !== undefined)
  await writeFile(${JSON.stringify(artifacts.pidPath)}, String(child.pid) + "\\n", { mode: 0o600 });
const copy = (destination, chunk) => {
  output.write(chunk);
  destination.write(chunk);
};
child.stdout.on("data", (chunk) => copy(process.stdout, chunk));
child.stderr.on("data", (chunk) => copy(process.stderr, chunk));
child.stdin.on("error", () => {});
if (${JSON.stringify(launch.promptDelivery)} === "stdin") child.stdin.end(prompt);
else child.stdin.end();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));

const result = await new Promise((resolve) => {
  let settled = false;
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    const diagnostic = String(error) + "\\n";
    output.write(diagnostic);
    process.stderr.write(diagnostic);
    resolve({ code: 127, signal: undefined });
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    resolve({ code, signal });
  });
});
await new Promise((resolve) => output.end(resolve));
const status = result.code ?? (result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1);
const temporary = ${JSON.stringify(`${artifacts.exitStatusPath}.tmp`)};
await writeFile(temporary, String(status) + "\\n", { mode: 0o600 });
await rename(temporary, ${JSON.stringify(artifacts.exitStatusPath)});
process.exitCode = status;
`;
}

function isActivationEvent(harness: Harness, event: Record<string, unknown>) {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (!type) return false;
  if (harness === "pi") return /^(agent|turn|message|tool)(_|\.)/.test(type);
  if (harness === "claude") {
    if (type === "user" || type === "assistant" || type === "result")
      return true;
    const nested =
      typeof event.event === "object" && event.event !== null
        ? (event.event as Record<string, unknown>).type
        : undefined;
    return (
      type === "stream_event" &&
      typeof nested === "string" &&
      /^(message|content_block)_/.test(nested)
    );
  }
  if (harness === "codex")
    return type === "turn.started" || /^(item|message|tool)\./.test(type);
  return /(^|[._])(step|message|text|tool)([._]|$)/.test(type);
}

export async function hasHeadlessActivity(
  artifacts: HeadlessRunArtifacts,
  harness: Harness,
) {
  try {
    if ((await stat(artifacts.outputPath)).size === 0) return false;
    const output = await readFile(artifacts.outputPath, "utf8");
    return output.split(/\r?\n/).some((line) => {
      if (!line.trim()) return false;
      try {
        const event: unknown = JSON.parse(line);
        return (
          typeof event === "object" &&
          event !== null &&
          isActivationEvent(harness, event as Record<string, unknown>)
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export async function readHeadlessExit(artifacts: HeadlessRunArtifacts) {
  try {
    const value = Number.parseInt(
      (await readFile(artifacts.exitStatusPath, "utf8")).trim(),
      10,
    );
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function readHeadlessOutput(artifacts: HeadlessRunArtifacts) {
  return readFile(artifacts.outputPath, "utf8").catch(() => "");
}

export function parseLeafOutcome(options: {
  harness: Harness;
  output: string;
  exitCode: number;
  fallbackSessionId?: string;
}): ParsedLeafOutcome {
  const assistantText = extractStructuredText(options.output).trim();
  const report = extractMarkedReport(assistantText) ?? assistantText;
  const structured = parseReportJson(report);
  const status =
    options.exitCode !== 0 || structured?.status === "failed"
      ? "failed"
      : structured?.status === "question"
        ? "blocked"
        : "done";
  return {
    status,
    report: report || options.output.trim(),
    sessionId: extractHarnessSessionId(
      options.harness,
      options.output,
      options.fallbackSessionId,
    ),
    exitCode: options.exitCode,
  };
}

function extractMarkedReport(output: string) {
  const startMarker = "PI_PARENT_REPORT_BEGIN";
  const endMarker = "PI_PARENT_REPORT_END";
  const end = output.lastIndexOf(endMarker);
  const start = output.lastIndexOf(startMarker, end);
  if (start < 0 || end <= start) return undefined;
  const report = output.slice(start + startMarker.length, end).trim();
  return report && report !== "<json-report>" ? report : undefined;
}

function parseReportJson(report: string) {
  try {
    const value = JSON.parse(report) as { status?: unknown };
    if (
      value.status === "done" ||
      value.status === "question" ||
      value.status === "failed"
    )
      return { status: value.status } as const;
  } catch {
    // A concise text report remains valid for backwards compatibility.
  }
  return undefined;
}
