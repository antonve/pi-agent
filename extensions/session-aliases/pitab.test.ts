import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandRunner } from "./free.ts";
import {
  normalizeGeneratedTabName,
  parseCreatedHerdrTab,
  runPitab,
} from "./pitab.ts";

interface RunnerOptions {
  lease?: boolean;
  startFails?: boolean;
}

function runnerFixture(options: RunnerOptions = {}) {
  const calls: Array<{
    command: string;
    args: readonly string[];
    cwd?: string;
    timeoutMs?: number;
  }> = [];
  const runner: CommandRunner = {
    async run(command, args, runOptions) {
      calls.push({ command, args, ...runOptions });
      if (command === "git" && args[0] === "rev-parse")
        return {
          stdout: options.lease ? "/lease\n" : "/repo\n",
          stderr: "",
          code: 0,
        };
      if (command === "treehouse" && args[0] === "status")
        return {
          stdout: JSON.stringify(
            options.lease
              ? [
                  {
                    path: "/lease",
                    status: "leased",
                    lease_id: "lease-1",
                  },
                ]
              : [],
          ),
          stderr: "",
          code: 0,
        };
      if (command === "git" && args[0] === "worktree")
        return {
          stdout: "worktree /repo\0HEAD abc\0\0worktree /lease\0HEAD def\0",
          stderr: "",
          code: 0,
        };
      if (command === "git" && args[0] === "status")
        return { stdout: "", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "tab" && args[1] === "create")
        return {
          stdout: JSON.stringify({
            result: {
              tab: { tab_id: "w1:t2" },
              root_pane: { pane_id: "w1:p2" },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent")
        return options.startFails
          ? { stdout: "", stderr: "agent failed", code: 1 }
          : { stdout: "started", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  return { runner, calls };
}

function context(cwd = "/repo/src") {
  return { cwd } as ExtensionCommandContext;
}

const herdrEnv = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" };

test("generated tab names normalize to one to three hyphenated words", () => {
  assert.equal(normalizeGeneratedTabName("`Horse Race`\n"), "horse-race");
  assert.equal(
    normalizeGeneratedTabName("One two three four five"),
    "one-two-three",
  );
  assert.throws(() => normalizeGeneratedTabName("---"), /usable tab name/);
});

test("Herdr tab creation output exposes the new tab and root pane", () => {
  assert.deepEqual(
    parseCreatedHerdrTab(
      JSON.stringify({
        result: {
          tab: { tab_id: "w1:t2" },
          root_pane: { pane_id: "w1:p2" },
        },
      }),
    ),
    { tabId: "w1:t2", paneId: "w1:p2" },
  );
});

test("pitab preserves an explicit label and starts Pi before focusing", async () => {
  const { runner, calls } = runnerFixture();
  let generated = false;

  const result = await runPitab("  My tab name  ", context(), {
    runner,
    env: herdrEnv,
    async generateName() {
      generated = true;
      return "unused";
    },
    agentName: () => "pitab-agent",
  });

  assert.equal(generated, false);
  assert.deepEqual(result, {
    tabId: "w1:t2",
    paneId: "w1:p2",
    label: "My tab name",
    repository: "/repo",
  });
  const create = calls.find(
    (call) => call.command === "herdr" && call.args[1] === "create",
  );
  assert.ok(create);
  assert.deepEqual(create.args, [
    "tab",
    "create",
    "--workspace",
    "w1",
    "--cwd",
    "/repo",
    "--label",
    "My tab name",
    "--no-focus",
  ]);
  const startIndex = calls.findIndex(
    (call) => call.command === "herdr" && call.args[0] === "agent",
  );
  const focusIndex = calls.findIndex(
    (call) =>
      call.command === "herdr" &&
      call.args[0] === "tab" &&
      call.args[1] === "focus",
  );
  assert.ok(startIndex >= 0 && focusIndex > startIndex);
});

test("pitab asks the model for a name only when none is supplied", async () => {
  const { runner, calls } = runnerFixture();
  let generations = 0;

  await runPitab("", context(), {
    runner,
    env: herdrEnv,
    async generateName() {
      generations++;
      return "horse-race";
    },
    agentName: () => "pitab-agent",
  });

  assert.equal(generations, 1);
  const create = calls.find(
    (call) => call.command === "herdr" && call.args[1] === "create",
  );
  assert.ok(create?.args.includes("horse-race"));
});

test("pitab uses the original repository when invoked from a lease", async () => {
  const { runner, calls } = runnerFixture({ lease: true });

  const result = await runPitab("review", context("/lease/src"), {
    runner,
    env: herdrEnv,
    async generateName() {
      return "unused";
    },
    agentName: () => "pitab-agent",
  });

  assert.equal(result.repository, "/repo");
  const create = calls.find(
    (call) => call.command === "herdr" && call.args[1] === "create",
  );
  assert.equal(create?.cwd, "/repo");
  assert.ok(create?.args.includes("/repo"));
});

test("pitab closes a newly created tab when Pi fails to start", async () => {
  const { runner, calls } = runnerFixture({ startFails: true });

  await assert.rejects(
    runPitab("review", context(), {
      runner,
      env: herdrEnv,
      async generateName() {
        return "unused";
      },
      agentName: () => "pitab-agent",
    }),
    /agent failed/,
  );

  assert.ok(
    calls.some(
      (call) =>
        call.command === "herdr" && call.args.join(" ") === "tab close w1:t2",
    ),
  );
  assert.equal(
    calls.some(
      (call) =>
        call.command === "herdr" && call.args.join(" ") === "tab focus w1:t2",
    ),
    false,
  );
});
