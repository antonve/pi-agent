import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { CapturedOutput } from "./output.ts";

const STDERR_MAX_BYTES = 64 * 1024;
const KILL_GRACE_MS = 1_000;

interface PreviewState {
  readonly decoder: TextDecoder;
  preview: string;
  totalBytes: number;
  lineBreaks: number;
  trailingLineBreaks: number;
  truncated: boolean;
}

function makePreviewState(): PreviewState {
  return {
    decoder: new TextDecoder(),
    preview: "",
    totalBytes: 0,
    lineBreaks: 0,
    trailingLineBreaks: 0,
    truncated: false,
  };
}

function observeStdout(state: PreviewState, chunk: Buffer) {
  state.totalBytes += chunk.byteLength;
  for (const byte of chunk) {
    if (byte === 0x0a) {
      state.lineBreaks++;
      state.trailingLineBreaks++;
    } else {
      state.trailingLineBreaks = 0;
    }
  }

  if (state.truncated) return;
  state.preview += state.decoder.decode(chunk, { stream: true });
  const truncation = truncateHead(state.preview, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (truncation.truncated) {
    state.preview = truncation.content;
    state.truncated = true;
  }
}

function finishStdout(state: PreviewState, fullOutputPath: string) {
  if (!state.truncated) state.preview += state.decoder.decode();
  const totalBytes = state.totalBytes - state.trailingLineBreaks;
  const lineCount =
    totalBytes === 0 ? 0 : state.lineBreaks - state.trailingLineBreaks + 1;
  return {
    preview: state.preview,
    lineCount,
    totalBytes,
    truncated: state.truncated,
    fullOutputPath: state.truncated ? fullOutputPath : undefined,
  } satisfies CapturedOutput;
}

type SearchChild = ChildProcessByStdio<null, Readable, Readable>;

function waitForExit(child: SearchChild) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
}

export async function executeSearchProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly tempPrefix: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), options.tempPrefix));
  const fullOutputPath = join(directory, "output.txt");
  let retainDirectory = false;
  let child: SearchChild | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  let timedOut = false;

  const terminate = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child?.kill("SIGKILL"), KILL_GRACE_MS);
    forceKill.unref?.();
  };
  const abort = () => {
    aborted = true;
    terminate();
  };

  try {
    if (options.signal?.aborted) throw new Error("Search was cancelled.");

    const preview = makePreviewState();
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const spawned = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    spawned.stdout.on("data", (chunk: Buffer) => observeStdout(preview, chunk));
    spawned.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_MAX_BYTES) return;
      const captured = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
      stderr.push(captured);
      stderrBytes += captured.byteLength;
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref?.();

    const [exit] = await Promise.all([
      waitForExit(spawned),
      pipeline(spawned.stdout, createWriteStream(fullOutputPath)),
    ]);
    if (aborted) throw new Error("Search was cancelled.");
    if (timedOut) throw new Error("Search timed out.");
    if (exit.code === null) {
      throw new Error(
        `process terminated by ${exit.signal ?? "unknown signal"}`,
      );
    }

    const output = finishStdout(preview, fullOutputPath);
    retainDirectory = output.truncated;
    return {
      code: exit.code,
      stderr: Buffer.concat(stderr).toString("utf8"),
      output,
    };
  } catch (error) {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    options.signal?.removeEventListener("abort", abort);
    if (!retainDirectory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function discardCapturedOutput(output: CapturedOutput) {
  if (!output.fullOutputPath) return;
  await rm(dirname(output.fullOutputPath), { recursive: true, force: true });
}
