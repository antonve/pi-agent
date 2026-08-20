import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { discardCapturedOutput, executeSearchProcess } from "./src/process.ts";

function runNode(
  script: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) {
  return executeSearchProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    tempPrefix: "pi-file-search-test-",
    signal: options?.signal,
    timeoutMs: options?.timeoutMs ?? 5_000,
  });
}

test("captures stdout metadata and bounded stderr", async () => {
  const result = await runNode(
    'process.stdout.write("first\\nsecond\\n"); process.stderr.write("warning"); process.exitCode = 2',
  );

  assert.equal(result.code, 2);
  assert.equal(result.stderr, "warning");
  assert.equal(result.output.preview, "first\nsecond\n");
  assert.equal(result.output.lineCount, 2);
  assert.equal(result.output.truncated, false);
  assert.equal(result.output.fullOutputPath, undefined);
});

test("retains and then discards full output only when truncated", async () => {
  const result = await runNode(
    "for (let i = 0; i < 2100; i++) process.stdout.write(`line-${i}\\n`)",
  );

  assert.equal(result.output.truncated, true);
  assert.equal(result.output.lineCount, 2100);
  assert.ok(result.output.fullOutputPath);
  await access(result.output.fullOutputPath);
  await discardCapturedOutput(result.output);
  await assert.rejects(access(result.output.fullOutputPath));
});

test("terminates the child when cancelled", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(
    runNode("setInterval(() => {}, 1000)", { signal: controller.signal }),
    /Search was cancelled/,
  );
});

test("terminates the child when the timeout expires", async () => {
  await assert.rejects(
    runNode("setInterval(() => {}, 1000)", { timeoutMs: 50 }),
    /Search timed out/,
  );
});
