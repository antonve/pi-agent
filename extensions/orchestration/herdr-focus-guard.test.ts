import assert from "node:assert/strict";
import { mkdtemp, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeCliRunner, type CliResult, type CliRunner } from "./cli.ts";
import { HerdrClient } from "./herdr-client.ts";

type Location = { workspaceId: string; tabId: string; paneId: string };
type SocketResponse = {
  result?: unknown;
  error?: { code: string; message: string };
  events?: unknown[];
  delayMs?: number;
};

function success(result: unknown = {}) {
  return {
    code: 0,
    stderr: "",
    stdout: JSON.stringify({ result }),
  } satisfies CliResult;
}

class DirectRunner implements CliRunner {
  readonly calls: string[][] = [];
  location: Location;

  constructor(location: Location) {
    this.location = location;
  }

  async run(command: string, args: readonly string[]) {
    assert.equal(command, "herdr");
    this.calls.push([...args]);
    if (args[0] === "pane" && args[1] === "get") return success({});
    throw new Error(
      `background command unexpectedly used CLI: ${args.join(" ")}`,
    );
  }
}

async function withNativeSocket<T>(
  runner: DirectRunner,
  run: (requests: Array<Record<string, unknown>>) => Promise<T>,
  respond: (
    method: string,
    params: Record<string, unknown>,
  ) => SocketResponse = () => ({ result: {} }),
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-focus-guard-"));
  const socketPath = join(directory, "herdr.sock");
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
        params: Record<string, unknown>;
      };
      requests.push(request);
      const response = respond(request.method, request.params);
      const complete = () => {
        for (const event of response.events ?? [])
          connection.write(`${JSON.stringify(event)}\n`);
        connection.end(
          `${JSON.stringify({
            id: request.id,
            ...(response.error
              ? { error: response.error }
              : { result: response.result ?? {} }),
          })}\n`,
        );
      };
      if (response.delayMs) setTimeout(complete, response.delayMs);
      else complete();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousRun = nodeCliRunner.run;
  process.env.HERDR_SOCKET_PATH = socketPath;
  nodeCliRunner.run = runner.run.bind(runner);
  try {
    return await run(requests);
  } finally {
    nodeCliRunner.run = previousRun;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
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

test("production prompting uses the native direct-target API without focus calls", async () => {
  const runner = new DirectRunner(owner);
  await withNativeSocket(
    runner,
    async (requests) => {
      await new HerdrClient(nodeCliRunner).promptAgent(
        "existing-agent",
        "continue",
      );
      assert.deepEqual(runner.location, target);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["agent.prompt"],
      );
    },
    (method, params) => {
      assert.equal(method, "agent.prompt");
      assert.deepEqual(params, {
        target: "existing-agent",
        text: "continue",
      });
      // This models genuine user navigation to the operation's target while a
      // long prompt is pending. Direct delivery must never restore elsewhere.
      runner.location = target;
      return { result: { pane_id: target.paneId, state_change_seq: 9 } };
    },
  );
});

test("direct pane send failure never changes or restores focus", async () => {
  const runner = new DirectRunner(owner);
  await withNativeSocket(
    runner,
    async (requests) => {
      await assert.rejects(
        new HerdrClient(nodeCliRunner).sendText(target.paneId, "hello"),
        /send failed/,
      );
      assert.deepEqual(runner.location, owner);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["pane.send_text"],
      );
    },
    () => ({ error: { code: "pane_unavailable", message: "send failed" } }),
  );
});

test("no-focus tab creation and direct run use native background methods", async () => {
  const runner = new DirectRunner(owner);
  await withNativeSocket(
    runner,
    async (requests) => {
      const client = new HerdrClient(nodeCliRunner);
      const resource = await client.createResource(
        owner,
        "tab",
        "/repo",
        "worker",
      );
      await client.runInPane(resource.paneId, "printf", ["done"]);
      assert.deepEqual(runner.location, owner);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["tab.create", "pane.send_input"],
      );
      const creationParams = requests[0]?.params as
        | Record<string, unknown>
        | undefined;
      assert.equal(creationParams?.focus, false);
      assert.deepEqual(requests[1]?.params, {
        pane_id: target.paneId,
        text: "'printf' 'done'",
        keys: ["enter"],
      });
    },
    (method) =>
      method === "tab.create"
        ? {
            result: {
              tab: { tab_id: target.tabId },
              root_pane: { pane_id: target.paneId },
            },
          }
        : { result: {} },
  );
});

test("completion closes a direct target without issuing pane.focus", async () => {
  const runner = new DirectRunner(owner);
  await withNativeSocket(runner, async (requests) => {
    await new HerdrClient(nodeCliRunner).closeResource({
      createdTab: true,
      tabId: target.tabId,
      createdPane: true,
      paneId: target.paneId,
    });
    assert.deepEqual(runner.location, owner);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["tab.close"],
    );
  });
});

test("same-identity focus events are tolerated as non-transfers", async () => {
  const runner = new DirectRunner(owner);
  await withNativeSocket(
    runner,
    async (requests) => {
      await new HerdrClient(nodeCliRunner).closeWorkspace(target.workspaceId);
      assert.deepEqual(runner.location, owner);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["workspace.close"],
      );
    },
    () => ({
      result: { workspace_id: target.workspaceId },
      events: [
        {
          event: "workspace_focused",
          data: { workspace_id: owner.workspaceId },
        },
        { event: "tab_focused", data: { tab_id: owner.tabId } },
        { event: "pane_focused", data: { pane_id: owner.paneId } },
      ],
    }),
  );
});

test("intentional navigation to an unrelated pane is never clobbered", async () => {
  const runner = new DirectRunner(owner);
  await withNativeSocket(
    runner,
    async (requests) => {
      await new HerdrClient(nodeCliRunner).promptAgent(
        "existing-agent",
        "continue",
      );
      assert.deepEqual(runner.location, userDestination);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["agent.prompt"],
      );
    },
    () => {
      runner.location = userDestination;
      return { result: { pane_id: target.paneId, state_change_seq: 8 } };
    },
  );
});
