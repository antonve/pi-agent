import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isAutoReloadIdle, registerAutoReload } from "./auto-reload.ts";

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function context(
  overrides: {
    mode?: ExtensionContext["mode"];
    idle?: boolean;
    pending?: boolean;
    draft?: string;
  } = {},
) {
  return {
    mode: overrides.mode ?? "tui",
    isIdle: () => overrides.idle ?? true,
    hasPendingMessages: () => overrides.pending ?? false,
    ui: { getEditorText: () => overrides.draft ?? "" },
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as ExtensionContext;
}

test("auto-reload idle policy rejects active work and draft input", () => {
  assert.equal(
    isAutoReloadIdle(context(), () => false),
    true,
  );
  assert.equal(
    isAutoReloadIdle(context({ idle: false }), () => false),
    false,
  );
  assert.equal(
    isAutoReloadIdle(context({ pending: true }), () => false),
    false,
  );
  assert.equal(
    isAutoReloadIdle(context({ draft: "unfinished" }), () => false),
    false,
  );
  assert.equal(
    isAutoReloadIdle(context({ mode: "print" }), () => false),
    false,
  );
  assert.equal(
    isAutoReloadIdle(context(), () => true),
    false,
  );
});

test("auto-reload retries until the session and tracked tasks are idle", async () => {
  const timers: FakeTimer[] = [];
  const eventHandlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => void>
  >();
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const sentMessages: string[] = [];
  let now = 0;
  let activeWait = false;
  let runningTasks = true;
  let pending = false;
  let reloads = 0;
  const ctx = {
    ...context(),
    hasPendingMessages: () => pending,
  } as ExtensionContext;
  const commandContext = {
    ...ctx,
    async reload() {
      reloads++;
    },
  } as ExtensionCommandContext;
  const pi = {
    registerCommand(
      _name: string,
      command: {
        handler: (
          args: string,
          commandCtx: ExtensionCommandContext,
        ) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;

  registerAutoReload(pi, {
    hasActiveWait: () => activeWait,
    hasRunningTasks: async () => runningTasks,
    intervalMs: 100,
    retryMs: 10,
    now: () => now,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  const start = eventHandlers.get("session_start")?.[0];
  const shutdown = eventHandlers.get("session_shutdown")?.[0];
  assert.ok(start);
  assert.ok(shutdown);
  assert.ok(commandHandler);
  start({}, ctx);
  assert.equal(timers.at(-1)?.delayMs, 100);

  now = 100;
  timers.at(-1)?.callback();
  await flush();
  assert.deepEqual(sentMessages, []);
  assert.equal(timers.at(-1)?.delayMs, 10);

  runningTasks = false;
  activeWait = true;
  now = 110;
  timers.at(-1)?.callback();
  await flush();
  assert.deepEqual(sentMessages, []);

  activeWait = false;
  now = 120;
  timers.at(-1)?.callback();
  await flush();
  assert.deepEqual(sentMessages, ["/auto-reload-when-idle scheduled"]);

  pending = true;
  await commandHandler("scheduled", commandContext);
  assert.equal(reloads, 0);
  assert.equal(timers.at(-1)?.delayMs, 10);

  pending = false;
  now = 130;
  timers.at(-1)?.callback();
  await flush();
  assert.equal(sentMessages.length, 2);
  await commandHandler("scheduled", commandContext);
  assert.equal(reloads, 1);

  const retryTimer = timers.at(-1);
  assert.ok(retryTimer);
  shutdown({}, ctx);
  assert.equal(retryTimer.cancelled, true);
});
