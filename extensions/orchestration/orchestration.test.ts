import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CliRunner } from "./cli.ts";
import { findString } from "./cli.ts";
import { buildHarnessLaunch } from "./harnesses.ts";
import { resolveIsolation, resolvePlacement } from "./placement.ts";
import { TaskRegistry } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";
import { extractFinalJson } from "./workflows/index.ts";

test("auto isolation is conservative", () => {
  assert.equal(
    resolveIsolation("auto", "Review the authentication code read-only"),
    "shared",
  );
  assert.equal(
    resolveIsolation("auto", "Implement the authentication fix"),
    "treehouse",
  );
  assert.equal(resolveIsolation("auto", "Investigate and fix it"), "treehouse");
});

test("durable and uncertain placement defaults to tab", () => {
  assert.equal(
    resolvePlacement({ requested: "auto", kind: "subagent" }),
    "tab",
  );
  assert.equal(
    resolvePlacement({ requested: "pane", kind: "background" }),
    "pane",
  );
});

test("harness defaults and native arguments", () => {
  assert.deepEqual(buildHarnessLaunch({ harness: "claude" }).args.slice(0, 4), [
    "--model",
    "fable",
    "--effort",
    "high",
  ]);
  const codex = buildHarnessLaunch({ harness: "codex" });
  assert.equal(codex.model, "gpt-5.6-sol");
  assert.ok(codex.args.includes('model_reasoning_effort="high"'));
  const pi = buildHarnessLaunch({
    harness: "pi",
    parentModel: "openai/gpt",
    parentReasoning: "medium",
  });
  assert.equal(pi.model, "openai/gpt");
  assert.ok(pi.args.includes("--exclude-tools"));
});

test("Herdr JSON IDs are decoded through response envelopes", () => {
  assert.equal(
    findString({ result: { pane: { pane_id: "w1:p2" } } }, ["pane_id"]),
    "w1:p2",
  );
});

test("Treehouse initializes, acquires, and guarded-returns without force", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let gets = 0;
  const runner: CliRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === "git") return { stdout: "/repo\n", stderr: "", code: 0 };
      if (args[0] === "get" && gets++ === 0)
        return { stdout: "", stderr: "not initialized", code: 1 };
      if (args[0] === "init") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "get")
        return {
          stdout: JSON.stringify({ path: "/lease", lease_id: "lease-1" }),
          stderr: "",
          code: 0,
        };
      return { stdout: "returned", stderr: "", code: 0 };
    },
  };
  const client = new TreehouseClient(runner);
  const lease = await client.acquire("/repo", "holder");
  await client.returnLease(lease);
  assert.ok(calls.some((call) => call.args[0] === "init"));
  const returned = calls.find((call) => call.args[0] === "return")!;
  assert.ok(returned.args.includes("--if-lease-id"));
  assert.ok(returned.args.includes("--if-lease-holder"));
  assert.ok(!returned.args.includes("--force"));
});

test("registry writes private durable JSON atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-registry-"));
  const path = join(directory, "registry.json");
  const registry = new TaskRegistry(path);
  const now = Date.now();
  await registry.put({
    id: "bg-1",
    label: "test",
    kind: "background",
    parentWorkspaceId: "w",
    parentTabId: "t",
    parentPaneId: "p",
    paneId: "p2",
    createdTab: false,
    createdPane: true,
    cwd: "/tmp",
    placement: "pane",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await registry.update("bg-1", { status: "done" });
  assert.equal((await registry.get("bg-1"))?.status, "done");
  assert.match(await readFile(path, "utf8"), /"bg-1"/);
});

test("structured workflow output takes the final schema-matching JSON", () => {
  const value = extractFinalJson('notes\n{"ok":true}', {
    type: "object",
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  });
  assert.deepEqual(value, { ok: true });
  assert.throws(() =>
    extractFinalJson('{"ok":"yes"}', {
      type: "object",
      properties: { ok: { type: "boolean" } },
    }),
  );
});
