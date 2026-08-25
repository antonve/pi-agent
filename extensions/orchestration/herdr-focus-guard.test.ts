import assert from "node:assert/strict";
import { mkdtemp, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeCliRunner, type CliResult, type CliRunner } from "./cli.ts";
import { HerdrClient } from "./herdr-client.ts";

type Location = { workspaceId: string; tabId: string; paneId: string };

function success(result: unknown = {}) {
  return {
    code: 0,
    stderr: "",
    stdout: JSON.stringify({ result }),
  } satisfies CliResult;
}

class FocusRunner implements CliRunner {
  readonly calls: string[][] = [];
  readonly locations = new Map<string, Location>();
  location: Location;
  mutate?: (args: readonly string[]) => Promise<CliResult | undefined>;

  constructor(location: Location) {
    this.location = location;
    this.locations.set(location.paneId, location);
  }

  register(location: Location) {
    this.locations.set(location.paneId, location);
  }

  async run(command: string, args: readonly string[]) {
    assert.equal(command, "herdr");
    this.calls.push([...args]);
    if (args[0] === "workspace" && args[1] === "list")
      return success({
        workspaces: [
          { workspace_id: this.location.workspaceId, focused: true },
        ],
      });
    if (args[0] === "pane" && args[1] === "list")
      return success({
        panes: [
          {
            workspace_id: this.location.workspaceId,
            tab_id: this.location.tabId,
            pane_id: this.location.paneId,
            focused: true,
          },
        ],
      });
    return (await this.mutate?.(args)) ?? success();
  }
}

async function withFocusSocket<T>(
  runner: FocusRunner,
  run: (
    focusRequests: string[],
    requests: Array<Record<string, unknown>>,
  ) => Promise<T>,
  respond: (
    method: string,
    params: Record<string, unknown>,
  ) => unknown = () => ({}),
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-focus-guard-"));
  const socketPath = join(directory, "herdr.sock");
  const focusRequests: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        method: string;
        params: Record<string, unknown> & { pane_id?: string };
      };
      requests.push(request);
      if (request.method === "pane.focus" && request.params.pane_id) {
        focusRequests.push(request.params.pane_id);
        const location = runner.locations.get(request.params.pane_id);
        if (location) runner.location = location;
      }
      connection.end(
        `${JSON.stringify({
          id: request.id,
          result: respond(request.method, request.params),
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socketPath;
  try {
    return await run(focusRequests, requests);
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  }
}

const owner = { workspaceId: "wA", tabId: "wA:t1", paneId: "wA:pE" };
const target = { workspaceId: "wB", tabId: "wB:t1", paneId: "wB:p1" };
const userDestination = {
  workspaceId: "wC",
  tabId: "wC:t7",
  paneId: "wC:p9",
};

function guardedClient(runner: FocusRunner) {
  return new HerdrClient(runner, {}, { guardBackgroundFocus: true });
}

test("existing-agent prompt restores the exact starting workspace, tab, and pane", async () => {
  const runner = new FocusRunner(owner);
  runner.register(target);
  runner.mutate = async (args) => {
    if (args[0] === "agent" && args[1] === "prompt") {
      runner.location = target;
      return success({ pane_id: target.paneId, state_change_seq: 7 });
    }
  };
  await withFocusSocket(runner, async (focusRequests) => {
    await guardedClient(runner).promptAgent("existing-agent", "continue");
    assert.deepEqual(runner.location, owner);
    assert.deepEqual(focusRequests, [owner.paneId]);
    assert.ok(
      runner.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "prompt" &&
          args[2] === "existing-agent",
      ),
    );
  });
});

test("production prompting uses the native direct-target socket API", async () => {
  const runner = new FocusRunner(owner);
  runner.register(target);
  runner.mutate = async (args) => {
    if (args[0] === "agent" && args[1] === "prompt")
      throw new Error("legacy prompt CLI must not run");
    return undefined;
  };
  const previousRun = nodeCliRunner.run;
  nodeCliRunner.run = runner.run.bind(runner);
  try {
    await withFocusSocket(
      runner,
      async (focusRequests, requests) => {
        await new HerdrClient(nodeCliRunner).promptAgent(
          "existing-agent",
          "continue",
        );
        assert.deepEqual(focusRequests, [owner.paneId]);
        assert.deepEqual(
          requests.map((request) => request.method),
          ["agent.prompt", "pane.focus"],
        );
        assert.deepEqual(runner.location, owner);
      },
      (method, params) => {
        if (method === "agent.prompt") {
          assert.deepEqual(params, {
            target: "existing-agent",
            text: "continue",
          });
          runner.location = target;
          return { pane_id: target.paneId, state_change_seq: 9 };
        }
        return {};
      },
    );
  } finally {
    nodeCliRunner.run = previousRun;
  }
});

test("direct pane send restores focus on failure", async () => {
  const runner = new FocusRunner(owner);
  runner.register(target);
  runner.mutate = async (args) => {
    if (args[0] === "pane" && args[1] === "send-text") {
      runner.location = target;
      return { code: 1, stdout: "", stderr: "send failed" };
    }
  };
  await withFocusSocket(runner, async (focusRequests) => {
    await assert.rejects(
      guardedClient(runner).sendText(target.paneId, "hello"),
      /send failed/,
    );
    assert.deepEqual(runner.location, owner);
    assert.deepEqual(focusRequests, [owner.paneId]);
  });
});

test("no-focus tab creation and direct run are guarded for spawn and bg paths", async () => {
  const runner = new FocusRunner(owner);
  runner.register(target);
  runner.mutate = async (args) => {
    if (args[0] === "tab" && args[1] === "create") {
      runner.location = target;
      return success({
        tab: { tab_id: target.tabId },
        root_pane: { pane_id: target.paneId },
      });
    }
    if (args[0] === "pane" && args[1] === "run") {
      runner.location = target;
      return success();
    }
  };
  await withFocusSocket(runner, async (focusRequests) => {
    const client = guardedClient(runner);
    const resource = await client.createResource(
      owner,
      "tab",
      "/repo",
      "worker",
    );
    await client.runInPane(resource.paneId, "printf", ["done"]);
    assert.deepEqual(runner.location, owner);
    assert.deepEqual(focusRequests, [owner.paneId, owner.paneId]);
    const creation = runner.calls.find(
      (args) => args[0] === "tab" && args[1] === "create",
    );
    assert.ok(creation?.includes("--no-focus"));
    assert.ok(
      runner.calls.some(
        (args) =>
          args[0] === "pane" && args[1] === "run" && args[2] === target.paneId,
      ),
    );
  });
});

test("completion close restores focus when external close behavior targets the resource", async () => {
  const runner = new FocusRunner(owner);
  runner.register(target);
  runner.mutate = async (args) => {
    if (args[0] === "tab" && args[1] === "close") {
      runner.location = target;
      return success({ tab_id: target.tabId, pane_id: target.paneId });
    }
  };
  await withFocusSocket(runner, async (focusRequests) => {
    await guardedClient(runner).closeResource({
      createdTab: true,
      tabId: target.tabId,
      createdPane: true,
      paneId: target.paneId,
    });
    assert.deepEqual(runner.location, owner);
    assert.deepEqual(focusRequests, [owner.paneId]);
  });
});

test("concurrent background controls serialize focus capture and restoration", async () => {
  const runner = new FocusRunner(owner);
  runner.register(target);
  let active = 0;
  let maxActive = 0;
  runner.mutate = async (args) => {
    if (args[0] === "pane" && args[1] === "send-text") {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runner.location = target;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return success();
    }
  };
  await withFocusSocket(runner, async (focusRequests) => {
    const client = guardedClient(runner);
    await Promise.all([
      client.sendText(target.paneId, "one"),
      client.sendText(target.paneId, "two"),
    ]);
    assert.equal(maxActive, 1);
    assert.deepEqual(runner.location, owner);
    assert.deepEqual(focusRequests, [owner.paneId, owner.paneId]);
  });
});

test("intentional navigation within a background target workspace is never clobbered", async () => {
  const sameWorkspaceDestination = {
    workspaceId: owner.workspaceId,
    tabId: "wA:t9",
    paneId: "wA:pZ",
  };
  const runner = new FocusRunner(owner);
  runner.register(sameWorkspaceDestination);
  runner.mutate = async (args) => {
    if (args[0] === "workspace" && args[1] === "rename") {
      runner.location = sameWorkspaceDestination;
      return success({ workspace_id: owner.workspaceId });
    }
  };
  await withFocusSocket(runner, async (focusRequests) => {
    await guardedClient(runner).renameWorkspace(owner.workspaceId, "renamed");
    assert.deepEqual(runner.location, sameWorkspaceDestination);
    assert.deepEqual(focusRequests, []);
  });
});

test("intentional navigation to an unrelated exact pane is never clobbered", async () => {
  const runner = new FocusRunner(owner);
  runner.register(target);
  runner.register(userDestination);
  runner.mutate = async (args) => {
    if (args[0] === "agent" && args[1] === "prompt") {
      runner.location = userDestination;
      return success({ pane_id: target.paneId, state_change_seq: 8 });
    }
  };
  await withFocusSocket(runner, async (focusRequests) => {
    await guardedClient(runner).promptAgent("existing-agent", "continue");
    assert.deepEqual(runner.location, userDestination);
    assert.deepEqual(focusRequests, []);
  });
});
