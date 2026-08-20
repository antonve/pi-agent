import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  BackgroundWaitRegistry,
  getBackgroundWaitRegistry,
  registerBackgroundWaitTask,
  registerBackgroundWaitTool,
  type BackgroundWaitResult,
} from "./background-waits.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("extensions share one wait registry per runtime event bus", () => {
  const events = {};
  const first = { events } as Pick<ExtensionAPI, "events">;
  const second = { events } as Pick<ExtensionAPI, "events">;
  const separate = { events: {} } as Pick<ExtensionAPI, "events">;
  const task = {
    id: "task-1",
    label: "Task",
    kind: "fixture",
    wait: async () => ({ status: "done", output: "done" }),
  };

  registerBackgroundWaitTask(first, task);

  assert.equal(getBackgroundWaitRegistry(second).get(task.id), task);
  assert.notEqual(
    getBackgroundWaitRegistry(first),
    getBackgroundWaitRegistry(separate),
  );
  getBackgroundWaitRegistry(first).dispose();
  getBackgroundWaitRegistry(separate).dispose();
});

test("background wait registry replaces tasks without stale unregisters", () => {
  const registry = new BackgroundWaitRegistry();
  const first = {
    id: "task-1",
    label: "first",
    kind: "fixture",
    wait: async () => ({ status: "done", output: "first" }),
  };
  const second = {
    ...first,
    label: "second",
    wait: async () => ({ status: "done", output: "second" }),
  };

  const unregisterFirst = registry.register(first);
  registry.register(second);
  unregisterFirst();

  assert.equal(registry.get("task-1"), second);
  assert.throws(() => registry.start(["missing"]), /Unknown background task/);
});

test("background_wait yields immediately and injects combined settled output", async () => {
  const tools = new Map<string, ToolDefinition>();
  const notifications: Array<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }> = [];
  const pi = {
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    sendMessage(
      message: Parameters<ExtensionAPI["sendMessage"]>[0],
      options: Parameters<ExtensionAPI["sendMessage"]>[1],
    ) {
      notifications.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const registry = new BackgroundWaitRegistry();
  const first = deferred<BackgroundWaitResult>();
  const second = deferred<BackgroundWaitResult>();
  registry.register({
    id: "ci-1",
    label: "CI checks",
    kind: "ci",
    wait: async () => first.promise,
  });
  registry.register({
    id: "deploy-1",
    label: "Deployment",
    kind: "deployment",
    wait: async () => second.promise,
  });
  registerBackgroundWaitTool(pi, registry);

  const tool = tools.get("background_wait");
  assert.ok(tool);
  const result = await tool.execute(
    "wait-call",
    { ids: ["ci-1", "deploy-1"] },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(result.terminate, true);
  assert.equal(notifications.length, 0);
  first.resolve({ status: "done", output: "checks passed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 0);
  second.resolve({
    status: "failed",
    output: "deployment failed",
    successful: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0]?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.equal(notifications[0]?.message.customType, "background-wait-result");
  assert.match(String(notifications[0]?.message.content), /checks passed/);
  assert.match(String(notifications[0]?.message.content), /deployment failed/);
  assert.deepEqual(notifications[0]?.message.details, {
    status: "settled",
    tasks: [
      {
        id: "ci-1",
        label: "CI checks",
        kind: "ci",
        status: "done",
        details: undefined,
      },
      {
        id: "deploy-1",
        label: "Deployment",
        kind: "deployment",
        status: "failed",
        details: undefined,
      },
    ],
  });
});

test("disposing background waits aborts providers without notifying the model", async () => {
  const notifications: unknown[] = [];
  const pi = {
    registerTool() {},
    sendMessage(message: unknown) {
      notifications.push(message);
    },
  } as unknown as ExtensionAPI;
  const registry = new BackgroundWaitRegistry();
  let aborted = false;
  registry.register({
    id: "task-1",
    label: "Task",
    kind: "fixture",
    wait: async (signal) =>
      new Promise<BackgroundWaitResult>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
  });
  const tool = registerBackgroundWaitTool(pi, registry);

  await tool(["task-1"]);
  registry.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(aborted, true);
  assert.equal(notifications.length, 0);
});
