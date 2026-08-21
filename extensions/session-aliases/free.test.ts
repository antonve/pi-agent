import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  discoverTreehouseLease,
  nextFreeLabel,
  runFree,
  type CommandRunner,
  type FreeReplacementContext,
} from "./free.ts";

function tabList(labels: string[]) {
  return JSON.stringify({
    result: { tabs: labels.map((label) => ({ label })) },
  });
}

function leaseRunner(options: { dirty?: boolean; leased?: boolean } = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === "git" && args[0] === "rev-parse")
        return { stdout: "/lease\n", stderr: "", code: 0 };
      if (command === "treehouse" && args[0] === "status")
        return {
          stdout: JSON.stringify(
            options.leased === false
              ? []
              : [
                  {
                    path: "/lease",
                    status: "leased",
                    lease_id: "lease-1",
                  },
                ],
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
        return {
          stdout: options.dirty ? " M file.ts\n" : "",
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[1] === "list")
        return { stdout: tabList(["free-0", "work"]), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  return { runner, calls };
}

function replacementContext() {
  const notifications: Array<{ message: string; level: string | undefined }> =
    [];
  const ctx = {
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as FreeReplacementContext;
  return { ctx, notifications };
}

function commandContext(options: { choice?: string } = {}) {
  let newSessions = 0;
  let switchedTo: string | undefined;
  const replacement = replacementContext();
  const ctx = {
    cwd: "/lease/subdirectory",
    hasUI: true,
    ui: {
      async select() {
        return options.choice;
      },
    },
    async newSession(config?: {
      withSession?: (ctx: FreeReplacementContext) => Promise<void>;
    }) {
      newSessions++;
      await config?.withSession?.(replacement.ctx);
      return { cancelled: false };
    },
    async switchSession(
      session: string,
      config?: {
        withSession?: (ctx: FreeReplacementContext) => Promise<void>;
      },
    ) {
      switchedTo = session;
      await config?.withSession?.(replacement.ctx);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    replacement,
    get newSessions() {
      return newSessions;
    },
    get switchedTo() {
      return switchedTo;
    },
  };
}

const herdrEnv = {
  HERDR_ENV: "1",
  HERDR_TAB_ID: "w1:t2",
  HERDR_WORKSPACE_ID: "w1",
};

test("free labels advance from the highest workspace label", () => {
  assert.equal(nextFreeLabel(tabList(["work", "review"])), "free-0");
  assert.equal(
    nextFreeLabel(tabList(["free-0", "free-7", "free-x"])),
    "free-8",
  );
});

test("Treehouse discovery identifies the current lease and main worktree", async () => {
  const { runner } = leaseRunner({ dirty: true });
  assert.deepEqual(await discoverTreehouseLease("/lease/src", runner), {
    path: "/lease",
    leaseId: "lease-1",
    originalRepository: "/repo",
    dirty: true,
  });
});

test("dirty lease abort leaves the session, tab, cwd, and lease unchanged", async () => {
  const { runner, calls } = leaseRunner({ dirty: true });
  const command = commandContext({ choice: "Abort" });
  let created = false;
  let changedDirectory = false;

  await runFree(command.ctx, {
    runner,
    env: herdrEnv,
    async createEmptySession() {
      created = true;
      return "/target.jsonl";
    },
    chdir() {
      changedDirectory = true;
    },
  });

  assert.equal(created, false);
  assert.equal(changedDirectory, false);
  assert.equal(command.switchedTo, undefined);
  assert.equal(command.newSessions, 0);
  assert.equal(
    calls.some((call) => call.command === "herdr"),
    false,
  );
  assert.equal(
    calls.some(
      (call) => call.command === "treehouse" && call.args[0] === "return",
    ),
    false,
  );
});

test("force-clean moves to the main worktree, returns the lease, and renames the tab", async () => {
  const { runner, calls } = leaseRunner({ dirty: true });
  const command = commandContext({ choice: "Force clean lease" });
  let changedTo: string | undefined;

  await runFree(command.ctx, {
    runner,
    env: herdrEnv,
    async createEmptySession(cwd) {
      assert.equal(cwd, "/repo");
      return "/target.jsonl";
    },
    chdir(cwd) {
      changedTo = cwd;
    },
  });

  assert.equal(command.switchedTo, "/target.jsonl");
  assert.equal(changedTo, "/repo");
  assert.ok(
    calls.some(
      (call) =>
        call.command === "treehouse" &&
        call.args.join(" ") === "return /lease --force --if-lease-id lease-1",
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.command === "herdr" &&
        call.args.join(" ") === "tab rename w1:t2 free-1",
    ),
  );
});

test("outside a lease, free starts an empty session and still renames the tab", async () => {
  const { runner, calls } = leaseRunner({ leased: false });
  const command = commandContext();

  await runFree(command.ctx, {
    runner,
    env: herdrEnv,
    async createEmptySession() {
      throw new Error("unexpected");
    },
    chdir() {
      throw new Error("unexpected");
    },
  });

  assert.equal(command.newSessions, 1);
  assert.equal(command.switchedTo, undefined);
  assert.ok(
    calls.some(
      (call) =>
        call.command === "herdr" &&
        call.args.join(" ") === "tab rename w1:t2 free-1",
    ),
  );
});
