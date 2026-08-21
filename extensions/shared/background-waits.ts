import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type ExtensionAPI,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface BackgroundWaitResult {
  status: string;
  output: string;
  successful?: boolean;
  details?: unknown;
}

export interface BackgroundWaitableTask {
  id: string;
  label: string;
  kind: string;
  wait(signal: AbortSignal): Promise<BackgroundWaitResult>;
}

export interface SettledBackgroundTask {
  task: Pick<BackgroundWaitableTask, "id" | "label" | "kind">;
  result: BackgroundWaitResult;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class BackgroundWaitRegistry {
  private readonly tasks = new Map<string, BackgroundWaitableTask>();
  private readonly active = new Set<AbortController>();

  register(task: BackgroundWaitableTask) {
    this.tasks.set(task.id, task);
    return () => {
      if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
    };
  }

  get(id: string) {
    return this.tasks.get(id);
  }

  hasActiveWaits() {
    return this.active.size > 0;
  }

  start(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const tasks = uniqueIds.map((id) => this.tasks.get(id));
    const missing = uniqueIds.filter((_id, index) => !tasks[index]);
    if (missing.length)
      throw new Error(`Unknown background task ${missing.join(", ")}.`);

    const registered = tasks as BackgroundWaitableTask[];
    const controller = new AbortController();
    this.active.add(controller);
    const completion = Promise.all(
      registered.map(async (task): Promise<SettledBackgroundTask> => {
        const metadata = {
          id: task.id,
          label: task.label,
          kind: task.kind,
        };
        try {
          return {
            task: metadata,
            result: await task.wait(controller.signal),
          };
        } catch (error) {
          return {
            task: metadata,
            result: {
              status: "failed",
              output: errorText(error),
              successful: false,
            },
          };
        }
      }),
    )
      .then((results) => ({
        aborted: controller.signal.aborted,
        results,
      }))
      .finally(() => this.active.delete(controller));

    return {
      tasks: registered.map(({ id, label, kind }) => ({ id, label, kind })),
      completion,
    };
  }

  dispose() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.tasks.clear();
  }
}

const registries = new WeakMap<object, BackgroundWaitRegistry>();

export function getBackgroundWaitRegistry(pi: Pick<ExtensionAPI, "events">) {
  const key = pi.events as object;
  let registry = registries.get(key);
  if (!registry) {
    registry = new BackgroundWaitRegistry();
    registries.set(key, registry);
  }
  return registry;
}

/** Register a provider-owned task with the wait tool in this extension runtime. */
export function registerBackgroundWaitTask(
  pi: Pick<ExtensionAPI, "events">,
  task: BackgroundWaitableTask,
) {
  return getBackgroundWaitRegistry(pi).register(task);
}

function combinedOutput(results: SettledBackgroundTask[]) {
  const output = results
    .map(
      ({ task, result }) =>
        `## ${task.id} [${result.status}] ${task.label}\n\n${result.output}`,
    )
    .join("\n\n---\n\n");
  const truncation = truncateTail(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return output;
  return `${truncation.content}\n\n[Combined output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full outputs remain available through their provider tools.]`;
}

export type BackgroundWaitExecutor = (
  ids: string[],
  signal?: AbortSignal,
) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: {
    tasks: Array<Pick<BackgroundWaitableTask, "id" | "label" | "kind">>;
  };
  terminate: true;
}>;

export function createBackgroundWaitExecutor(
  pi: ExtensionAPI,
  registry: BackgroundWaitRegistry,
): BackgroundWaitExecutor {
  return async (ids, signal) => {
    if (signal?.aborted) throw new Error("Background wait cancelled.");
    const wait = registry.start(ids);

    void wait.completion.then(({ aborted, results }) => {
      if (aborted) return;
      const successful = results.every(
        ({ result }) => result.successful ?? result.status === "done",
      );
      try {
        pi.sendMessage(
          {
            customType: "background-wait-result",
            content: combinedOutput(results),
            display: true,
            details: {
              status: successful ? "done" : "settled",
              tasks: results.map(({ task, result }) => ({
                ...task,
                status: result.status,
                details: result.details,
              })),
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch {
        /* Providers retain their own durable task output for later inspection. */
      }
    });

    return {
      content: [
        {
          type: "text",
          text: `Waiting in the background for ${wait.tasks.map((task) => task.id).join(", ")}. This turn is ending now; combined output will be delivered automatically after every requested task settles.`,
        },
      ],
      details: { tasks: wait.tasks },
      terminate: true,
    };
  };
}

export const renderBackgroundWaitResult: MessageRenderer = (
  message,
  options,
  theme,
) => {
  const details = (message.details ?? {}) as {
    status?: string;
    tasks?: unknown[];
  };
  const status = details.status ?? "settled";
  const taskCount = Array.isArray(details.tasks) ? details.tasks.length : 0;
  const statusLabel = status === "done" ? "completed" : status;
  const summary =
    theme.fg(
      status === "done" ? "success" : "warning",
      `background wait ${statusLabel}`,
    ) +
    theme.fg("muted", ` · ${taskCount} ${taskCount === 1 ? "task" : "tasks"}`);
  if (!options.expanded) return new Text(summary, 0, 0);

  const content = typeof message.content === "string" ? message.content : "";
  return new Text(`${summary}${content ? `\n${content}` : ""}`, 0, 0);
};

export function registerBackgroundWaitTool(
  pi: ExtensionAPI,
  registry: BackgroundWaitRegistry,
) {
  const executeWait = createBackgroundWaitExecutor(pi, registry);
  pi.registerMessageRenderer(
    "background-wait-result",
    renderBackgroundWaitResult,
  );
  pi.registerTool({
    name: "background_wait",
    label: "Wait for Background Tasks",
    description:
      "Yield the current turn while registered asynchronous tasks continue. Accepts only task IDs returned by tools that explicitly support background waiting; combined output automatically starts a new turn after all requested tasks settle.",
    promptSnippet:
      "Yield the current turn while registered asynchronous tasks continue and receive their combined output later",
    promptGuidelines: [
      "Use background_wait only with registered task IDs explicitly returned by another tool, and only when blocked on their results.",
    ],
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_call, params, signal) {
      return executeWait(params.ids, signal);
    },
  });
  return executeWait;
}
