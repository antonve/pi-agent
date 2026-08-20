import { resolve as resolvePath } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { nodeCliRunner } from "./cli.ts";
import {
  HARNESSES,
  ISOLATIONS,
  needsInspection,
  PLACEMENTS,
  REASONING_LEVELS,
  type Harness,
  type ReasoningLevel,
  type TaskRecord,
} from "./domain.ts";
import { HerdrClient } from "./herdr-client.ts";
import { OrchestrationManager } from "./manager.ts";
import { TaskRegistry } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";
import { registerWorkflow } from "./workflows/index.ts";
import { shouldRenderToolPart } from "../shared/calm-tool-output.ts";

function renderResultText(result: AgentToolResult<unknown>, theme: Theme) {
  const content = result.content.find((block) => block.type === "text");
  return new Text(
    content?.type === "text" ? theme.fg("toolOutput", content.text) : "",
    0,
    0,
  );
}

function compactSubagentRendering<TArgs>(summary: (args: TArgs) => string) {
  return {
    renderShell: "self" as const,
    renderCall(
      args: TArgs,
      theme: Theme,
      context: { expanded: boolean; isError: boolean },
    ) {
      const title = theme.fg("toolTitle", theme.bold(summary(args)));
      if (!context.expanded && !context.isError) return new Text(title, 0, 0);
      return new Text(
        `${title}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`,
        0,
        0,
      );
    },
    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: { isError: boolean },
    ) {
      return shouldRenderToolPart(
        "compact",
        "result",
        options.expanded,
        context.isError,
      )
        ? renderResultText(result, theme)
        : new Container();
    },
  };
}

function describe(task: TaskRecord) {
  const lease = task.lease
    ? ` · lease ${task.lease.leaseId.slice(0, 8)} (${task.lease.returnState})`
    : "";
  const agent = task.harness
    ? ` · ${task.harness}${task.model ? `/${task.model}` : ""}`
    : "";
  return `${task.id} [${task.status}] ${task.label}${agent} · ${task.placement} · ${task.cwd}${lease}`;
}

export const renderHerdrTaskResult: MessageRenderer = (
  message,
  options,
  theme,
) => {
  const details = (message.details ?? {}) as {
    status?: string;
    label?: string;
    id?: string;
    kind?: string;
  };
  const color = details.status === "done" ? "success" : "warning";
  const summary =
    theme.fg(color, `${details.id ?? "task"} ${details.status ?? "settled"}`) +
    theme.fg("muted", ` · ${details.label ?? ""}`);
  if (
    !options.expanded &&
    (details.kind === "background" || details.kind === "subagent") &&
    details.status === "done"
  )
    return new Text(summary, 0, 0);

  const content = typeof message.content === "string" ? message.content : "";
  const output = content.split("\n").slice(1).join("\n").trim();
  return new Text(`${summary}${output ? `\n${output}` : ""}`, 0, 0);
};

async function resolvePiModel(
  ctx: ExtensionContext,
  requested: string | undefined,
) {
  if (!requested) return undefined;
  const models = ctx.modelRegistry.getAll();
  let candidates =
    requested.toLowerCase() === "grok"
      ? models.filter((model) =>
          /grok|xai/i.test(`${model.provider}/${model.id}`),
        )
      : models.filter(
          (model) =>
            `${model.provider}/${model.id}` === requested ||
            model.id === requested,
        );
  if (candidates.length === 0) {
    const detail = requested.toLowerCase().includes("grok")
      ? "No Grok model is configured in Pi."
      : `Pi model is unavailable: ${requested}`;
    throw new Error(detail);
  }
  if (
    candidates.length > 1 &&
    requested.toLowerCase() !== "grok" &&
    !requested.includes("/")
  )
    throw new Error(
      `Pi model id is ambiguous: ${requested}; use provider/model-id.`,
    );
  for (const model of candidates) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok) return `${model.provider}/${model.id}`;
  }
  throw new Error(`Pi model is configured but unauthenticated: ${requested}`);
}

function commandHelp(kind: "ps" | "subagents") {
  const noun = kind === "ps" ? "background task" : "subagent";
  return `${kind}: list | output <id> | focus <id> | send <id> <text> | keys <id> <key...> | interrupt <id> | close <id>${kind === "subagents" ? " | attach <id>" : ""}\nActions only affect tracked ${noun} resources.`;
}

export default function orchestration(pi: ExtensionAPI) {
  const registry = new TaskRegistry();
  let context: ExtensionContext | undefined;
  const manager = new OrchestrationManager(
    new HerdrClient(nodeCliRunner),
    new TreehouseClient(nodeCliRunner),
    registry,
    {
      onComplete(task, output) {
        try {
          pi.sendMessage(
            {
              customType: "herdr-task-result",
              content: `${task.kind} ${task.id} “${task.label}” ${task.status}.\n\n${output}`,
              display: true,
              details: {
                id: task.id,
                kind: task.kind,
                status: task.status,
                label: task.label,
              },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        } catch {
          /* The durable result remains in the registry/result file. */
        }
      },
      onChange() {
        void updateStatus();
      },
    },
  );

  async function updateStatus() {
    if (!context?.hasUI) return;
    const tasks = await manager
      .list(context.sessionManager.getSessionId())
      .catch(() => []);
    const running = tasks.filter(
      (task) => task.status === "running" || task.status === "starting",
    ).length;
    const failed = tasks.filter((task) => needsInspection(task)).length;
    context.ui.setStatus(
      "herdr-orchestration",
      running || failed
        ? context.ui.theme.fg(
            failed ? "warning" : "muted",
            `Herdr: ${running} running${failed ? ` · ${failed} inspect` : ""}`,
          )
        : undefined,
    );
  }

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    void manager.reconcile().catch((error) => {
      if (ctx.hasUI && process.env.HERDR_ENV === "1")
        ctx.ui.notify(
          `Herdr reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
    });
    void updateStatus();
    pi.setActiveTools(
      pi.getActiveTools().filter((name) => name !== "workflow"),
    );
  });

  pi.on("input", (event) => {
    if (/\b(workflow|ultracode)\b/i.test(event.text)) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "workflow"])]);
    }
    return { action: "continue" };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    context = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("herdr-orchestration", undefined);
  });

  pi.registerMessageRenderer("herdr-task-result", renderHerdrTaskResult);

  pi.registerTool({
    name: "bg_start",
    label: "Start Herdr Background Task",
    description:
      "Start a long-running command in a visible Herdr tab/pane without changing focus. Returns immediately; completion is delivered automatically.",
    promptSnippet:
      "Start a visible Herdr background command for servers, watchers, long builds, or long tests",
    promptGuidelines: [
      "Use bg_start for long-running commands; use bash for quick commands. Continue useful work after bg_start because completion is delivered automatically.",
    ],
    parameters: Type.Object({
      command: Type.String(),
      title: Type.String(),
      working_dir: Type.Optional(Type.String()),
      placement: Type.Optional(StringEnum(PLACEMENTS)),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("bg_start cancelled.");
      const task = await manager.startBackground({
        command: params.command,
        label: params.title,
        cwd: resolvePath(ctx.cwd, params.working_dir ?? "."),
        placement: params.placement ?? "auto",
        parentSession: ctx.sessionManager.getSessionId(),
      });
      return {
        content: [
          {
            type: "text",
            text: `Started ${describe(task)}. Continue working; completion will be delivered automatically.`,
          },
        ],
        details: task,
      };
    },
    renderShell: "self",
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("ps start ")) +
          theme.fg("accent", args.title),
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (
        shouldRenderToolPart(
          "compact",
          "result",
          options.expanded,
          context.isError,
        )
      )
        return renderResultText(result, theme);
      return new Container();
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Inspect Herdr Background Task",
    description:
      "Read current status and concise live output for a tracked background task.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_call, params) {
      const task = await registry.get(params.id);
      if (!task || task.kind !== "background")
        throw new Error(`Unknown background task ${params.id}.`);
      return {
        content: [
          {
            type: "text",
            text: `${describe(task)}\n\n${await manager.output(task.id)}`,
          },
        ],
        details: task,
      };
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      if (
        !shouldRenderToolPart(
          "hidden",
          "call",
          context.expanded,
          context.isError,
        )
      )
        return new Container();
      return new Text(
        theme.fg("toolTitle", theme.bold("ps status ")) +
          theme.fg("accent", args.id),
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (
        !shouldRenderToolPart(
          "hidden",
          "result",
          options.expanded,
          context.isError,
        )
      )
        return new Container();
      return renderResultText(result, theme);
    },
  });
  pi.registerTool({
    name: "bg_list",
    label: "List Herdr Background Tasks",
    description:
      "List tracked background commands and their Herdr placement/status.",
    parameters: Type.Object({}),
    async execute(_call, _params, _signal, _update, ctx) {
      const tasks = (
        await manager.list(ctx.sessionManager.getSessionId())
      ).filter((task) => task.kind === "background");
      return {
        content: [
          {
            type: "text",
            text: tasks.length
              ? tasks.map(describe).join("\n")
              : "No background tasks.",
          },
        ],
        details: { tasks },
      };
    },
    renderShell: "self",
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("ps")), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (
        shouldRenderToolPart(
          "compact",
          "result",
          options.expanded,
          context.isError,
        )
      )
        return renderResultText(result, theme);
      return new Container();
    },
  });
  pi.registerTool({
    name: "bg_kill",
    label: "Interrupt Herdr Background Tasks",
    description:
      "Send Ctrl+C to tracked background commands. Their panes remain visible for inspection.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_call, params) {
      const tasks = await Promise.all(
        params.ids.map((taskId) => manager.cancel(taskId)),
      );
      return {
        content: [
          {
            type: "text",
            text: tasks
              .map(
                (task) =>
                  `Interrupted ${task.id}; its Herdr resource remains open.`,
              )
              .join("\n"),
          },
        ],
        details: { tasks },
      };
    },
    renderShell: "self",
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("ps interrupt ")) +
          theme.fg("accent", args.ids.join(", ")),
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (
        shouldRenderToolPart(
          "compact",
          "result",
          options.expanded,
          context.isError,
        )
      )
        return renderResultText(result, theme);
      return new Container();
    },
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Herdr Subagent",
    description:
      "Spawn a visible Pi, Claude Code, Codex, or OpenCode child through Herdr. Mutation-capable work gets an isolated durable Treehouse lease by default.",
    promptSnippet:
      "Delegate a self-contained task to a visible Herdr child agent with optional Treehouse isolation",
    promptGuidelines: [
      "Use subagent_spawn for self-contained delegated work. Supply complete paths, constraints, and expected output; continue parent work after spawning and wait only when blocked.",
    ],
    parameters: Type.Object({
      prompt: Type.String(),
      name: Type.String(),
      harness: StringEnum(HARNESSES),
      working_dir: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      reasoning_effort: Type.Optional(StringEnum(REASONING_LEVELS)),
      isolation: Type.Optional(StringEnum(ISOLATIONS)),
      placement: Type.Optional(StringEnum(PLACEMENTS)),
    }),
    async execute(_call, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Subagent spawn cancelled.");
      let model = params.model;
      let reasoning = params.reasoning_effort as ReasoningLevel | undefined;
      if (params.harness === "pi") {
        model = await resolvePiModel(ctx, model);
        if (params.model?.toLowerCase().includes("grok")) reasoning ??= "high";
      }
      const task = await manager.spawnAgent({
        prompt: params.prompt,
        label: params.name,
        harness: params.harness as Harness,
        cwd: resolvePath(ctx.cwd, params.working_dir ?? "."),
        model,
        reasoning,
        isolation: params.isolation ?? "auto",
        placement: params.placement ?? "auto",
        parentSession: ctx.sessionManager.getSessionId(),
        parentModel: ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : undefined,
        parentReasoning: pi.getThinkingLevel() as ReasoningLevel,
      });
      return {
        content: [
          {
            type: "text",
            text: `Spawned ${describe(task)}. Continue useful work; the result will be delivered automatically.`,
          },
        ],
        details: task,
      };
    },
    ...compactSubagentRendering(
      (args: { name: string }) => `subagent spawn ${args.name}`,
    ),
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Herdr Subagents",
    description: "Wait only when blocked on one or more child results.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_call, params, signal) {
      const tasks = await manager.wait(params.ids, signal);
      const sections = await Promise.all(
        tasks.map(
          async (task) =>
            `## ${describe(task)}\n\n${await manager.output(task.id)}`,
        ),
      );
      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: { tasks },
      };
    },
    ...compactSubagentRendering(
      (args: { ids: string[] }) => `subagent wait ${args.ids.join(", ")}`,
    ),
  });
  pi.registerTool({
    name: "subagent_check",
    label: "Inspect Herdr Subagent",
    description:
      "Read a tracked child status and recent activity without blocking.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_call, params) {
      const task = await registry.get(params.id);
      if (!task || task.kind === "background")
        throw new Error(`Unknown subagent ${params.id}.`);
      return {
        content: [
          {
            type: "text",
            text: `${describe(task)}\n\n${await manager.output(task.id)}`,
          },
        ],
        details: task,
      };
    },
    ...compactSubagentRendering(
      (args: { id: string }) => `subagent check ${args.id}`,
    ),
  });
  pi.registerTool({
    name: "subagent_list",
    label: "List Herdr Subagents",
    description:
      "List tracked subagents with harness, model, cwd, placement, and Treehouse lease.",
    parameters: Type.Object({}),
    async execute(_call, _params, _signal, _update, ctx) {
      const tasks = (
        await manager.list(ctx.sessionManager.getSessionId())
      ).filter((task) => task.kind !== "background");
      return {
        content: [
          {
            type: "text",
            text: tasks.length
              ? tasks.map(describe).join("\n")
              : "No subagents.",
          },
        ],
        details: { tasks },
      };
    },
    ...compactSubagentRendering(() => "subagents"),
  });
  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Herdr Subagents",
    description:
      "Interrupt child agents while retaining their visible tabs/panes and leases for inspection.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_call, params) {
      const tasks = await Promise.all(
        params.ids.map((taskId) => manager.cancel(taskId)),
      );
      return {
        content: [
          {
            type: "text",
            text: tasks
              .map(
                (task) =>
                  `Cancelled ${task.id}; resource retained for inspection.`,
              )
              .join("\n"),
          },
        ],
        details: { tasks },
      };
    },
    ...compactSubagentRendering(
      (args: { ids: string[] }) => `subagent cancel ${args.ids.join(", ")}`,
    ),
  });
  pi.registerTool({
    name: "subagent_send",
    label: "Send Herdr Subagent Follow-up",
    description:
      "Send a follow-up prompt to a tracked child. Cancels pending successful auto-close.",
    parameters: Type.Object({ id: Type.String(), prompt: Type.String() }),
    async execute(_call, params) {
      const task = await manager.send(params.id, params.prompt);
      return {
        content: [{ type: "text", text: `Sent follow-up to ${task.id}.` }],
        details: task,
      };
    },
    ...compactSubagentRendering(
      (args: { id: string }) => `subagent send ${args.id}`,
    ),
  });

  async function dashboard(
    kind: "ps" | "subagents",
    rawArgs: string,
    ctx: ExtensionContext,
  ) {
    manager.assertAvailable();
    const [action = "list", taskId, ...rest] = rawArgs
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const tasks = (
      await manager.list(ctx.sessionManager.getSessionId())
    ).filter((task) =>
      kind === "ps" ? task.kind === "background" : task.kind !== "background",
    );
    if (action === "list") {
      ctx.ui.notify(
        tasks.length
          ? tasks.map(describe).join("\n")
          : `No ${kind === "ps" ? "background tasks" : "subagents"}.`,
        "info",
      );
      return;
    }
    if (!taskId) {
      ctx.ui.notify(commandHelp(kind), "warning");
      return;
    }
    if (action === "output")
      ctx.ui.notify(await manager.output(taskId), "info");
    else if (action === "focus") await manager.focus(taskId);
    else if (action === "send") await manager.send(taskId, rest.join(" "));
    else if (action === "keys") await manager.keys(taskId, rest);
    else if (action === "interrupt") await manager.cancel(taskId);
    else if (action === "close") await manager.close(taskId);
    else if (action === "attach" && kind === "subagents")
      await manager.attach(taskId);
    else ctx.ui.notify(commandHelp(kind), "warning");
  }

  pi.registerCommand("ps", {
    description: "Inspect and interact with tracked Herdr background tasks",
    handler: (args, ctx) => dashboard("ps", args, ctx),
  });
  pi.registerCommand("subagents", {
    description:
      "Inspect, communicate with, focus, or take over Herdr subagents",
    handler: (args, ctx) => dashboard("subagents", args, ctx),
  });

  registerWorkflow(pi, manager, describe);
}
