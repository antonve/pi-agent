import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const AUTO_RELOAD_INTERVAL_MS = 60 * 60 * 1_000;
export const AUTO_RELOAD_RETRY_MS = 15_000;
const AUTO_RELOAD_COMMAND = "auto-reload-when-idle";
const SCHEDULED_ARGUMENT = "scheduled";

type CancelTimer = () => void;

export interface AutoReloadOptions {
  hasActiveWait(): boolean;
  hasRunningTasks(sessionId: string): Promise<boolean>;
  intervalMs?: number;
  retryMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => CancelTimer;
}

function defaultSchedule(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export function isAutoReloadIdle(
  ctx: ExtensionContext,
  hasActiveWait: () => boolean,
) {
  return (
    ctx.mode === "tui" &&
    ctx.isIdle() &&
    !ctx.hasPendingMessages() &&
    !hasActiveWait() &&
    ctx.ui.getEditorText().trim().length === 0
  );
}

export function registerAutoReload(
  pi: ExtensionAPI,
  options: AutoReloadOptions,
) {
  const intervalMs = options.intervalMs ?? AUTO_RELOAD_INTERVAL_MS;
  const retryMs = options.retryMs ?? AUTO_RELOAD_RETRY_MS;
  const now = options.now ?? Date.now;
  const scheduleCallback = options.schedule ?? defaultSchedule;
  let context: ExtensionContext | undefined;
  let intervalStartedAt = 0;
  let cancelTimer: CancelTimer | undefined;
  let commandRequested = false;
  let checking = false;
  let reloading = false;

  function clearTimer() {
    cancelTimer?.();
    cancelTimer = undefined;
  }

  function schedule(delayMs: number) {
    clearTimer();
    cancelTimer = scheduleCallback(() => {
      cancelTimer = undefined;
      void requestReloadIfIdle();
    }, delayMs);
  }

  function retry() {
    if (context) schedule(retryMs);
  }

  function intervalElapsed() {
    return now() - intervalStartedAt >= intervalMs;
  }

  async function fullyIdle(ctx: ExtensionContext) {
    if (!intervalElapsed() || !isAutoReloadIdle(ctx, options.hasActiveWait))
      return false;
    const sessionId = ctx.sessionManager.getSessionId();
    const hasRunningTasks = await options
      .hasRunningTasks(sessionId)
      .catch(() => true);
    return (
      !hasRunningTasks &&
      context === ctx &&
      intervalElapsed() &&
      isAutoReloadIdle(ctx, options.hasActiveWait)
    );
  }

  async function requestReloadIfIdle() {
    const ctx = context;
    if (!ctx || commandRequested || checking || reloading) {
      if (ctx) retry();
      return;
    }
    checking = true;
    try {
      if (!(await fullyIdle(ctx))) {
        retry();
        return;
      }
      commandRequested = true;
      try {
        pi.sendUserMessage(`/${AUTO_RELOAD_COMMAND} ${SCHEDULED_ARGUMENT}`, {
          expandPromptTemplates: true,
        });
      } catch {
        commandRequested = false;
        retry();
      }
    } finally {
      checking = false;
    }
  }

  async function runScheduledReload(ctx: ExtensionCommandContext) {
    commandRequested = false;
    const current = context;
    if (!current || !(await fullyIdle(current))) {
      retry();
      return;
    }

    reloading = true;
    schedule(retryMs);
    await ctx.reload();
    reloading = false;
  }

  pi.registerCommand(AUTO_RELOAD_COMMAND, {
    description: "Internal command used to reload a fully idle Pi session",
    async handler(args, ctx) {
      if (args.trim() !== SCHEDULED_ARGUMENT || !commandRequested) return;
      await runScheduledReload(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    clearTimer();
    context = ctx;
    commandRequested = false;
    checking = false;
    reloading = false;
    intervalStartedAt = now();
    if (ctx.mode === "tui") schedule(intervalMs);
  });

  pi.on("session_shutdown", () => {
    clearTimer();
    context = undefined;
    commandRequested = false;
    checking = false;
    reloading = false;
  });
}
