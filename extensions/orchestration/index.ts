import { resolve as resolvePath } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
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
import { registerAutoReload } from "./auto-reload.ts";
import { nodeCliRunner } from "./cli.ts";
import {
  HARNESSES,
  ISOLATIONS,
  needsInspection,
  REASONING_LEVELS,
  type Harness,
  type ReasoningLevel,
  type TaskRecord,
} from "./domain.ts";
import { FleetManager, formatFleetMessage } from "./fleet-manager.ts";
import { FleetStore, type FleetMessage } from "./fleet.ts";
import { HerdrClient } from "./herdr-client.ts";
import { OrchestrationManager } from "./manager.ts";
import { FirstMateTodoPaneController } from "./first-mate-todo-pane.ts";
import { compileFleetReports } from "./report-compiler.ts";
import { TaskRegistry } from "./registry.ts";
import { TreehouseClient } from "./treehouse-client.ts";
import { registerWorkflow } from "./workflows/index.ts";
import {
  BackgroundWaitRegistry,
  getBackgroundWaitRegistry,
  registerBackgroundWaitTool,
  type BackgroundWaitExecutor,
} from "../shared/background-waits.ts";
import { shouldRenderToolPart } from "../shared/calm-tool-output.ts";
import {
  FIRST_MATE_DEFAULT,
  resolveSecondMatePolicy,
  resolveWorkerPolicy,
  WORKER_ROLES,
  type WorkerRole,
} from "../shared/model-policy.ts";

const FIRST_MATE_MESSAGE_TYPES = [
  "DECISION_RESPONSE",
  "SCOPE_UPDATE",
  "PRIORITY_UPDATE",
  "PAUSE",
  "RESUME",
] as const;
const SECOND_MATE_ESCALATIONS = [
  "DECISION_REQUEST",
  "MATERIAL_RISK",
  "TASK_BLOCKED",
] as const;
const JOB_KINDS = ["finite", "service"] as const;
const TAB_PLACEMENTS = ["auto", "tab"] as const;
const FIRST_MATE_SUPERVISORY_PROMPT = `IMPORTANT: This session owns the singleton first-mate role for this machine.
- Stay in the supervisory first-mate role.
- For any new repo-changing request, call task_assign before inspecting files, acquiring a Treehouse lease, editing code, or making other repository changes yourself.
- After assignment, coordinate through task_list, task_send, and task_cancel instead of taking over the repository work directly.
- Delegated second mates own detailed planning, \`~/xdev/plans\` persistence and updates, implementation context, and follow-through for their tasks.
- Keep first-mate notes limited to concise decisions and portfolio status; do not write detailed task plans or perform task research yourself.
- Do not perform task-specific Linear discovery or writes, including issue creation, description edits, comments, relations, or workflow transitions.
- Pass concise user Linear requests and decisions to the owning second mate with task_send; when no second mate owns the work, use task_assign to delegate a short Linear task instead of handling it yourself.
- If a design task still has expected implementation work after a user decision, keep the delegated task active or resume it instead of terminally completing it and losing ownership/context.
- You may answer non-repository questions or summarize task status directly when no delegated repo work is required.`;

function renderResultText(result: AgentToolResult<unknown>, theme: Theme) {
  const content = result.content.find((block) => block.type === "text");
  return new Text(
    content?.type === "text" ? theme.fg("toolOutput", content.text) : "",
    0,
    0,
  );
}

function renderDetailedResult(result: AgentToolResult<unknown>, theme: Theme) {
  const content = result.content.find((block) => block.type === "text");
  const text = content?.type === "text" ? content.text : "";
  const details =
    result.details === undefined
      ? ""
      : theme.fg("muted", JSON.stringify(result.details, null, 2));
  return new Text([text, details].filter(Boolean).join("\n"), 0, 0);
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

function compactFirstMateControlRendering<TArgs>(
  summary: (args: TArgs) => string,
) {
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
        ? renderDetailedResult(result, theme)
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

const FIRST_MATE_CONTROL_WARNING_TYPES = new Set<FleetMessage["type"]>([
  "DECISION_REQUEST",
  "MATERIAL_RISK",
  "TASK_BLOCKED",
  "CANCEL",
]);

function firstMateControlSummary(message: FleetMessage, theme: Theme) {
  const label = message.type.toLowerCase().replaceAll("_", " ");
  const payload = message.payload;
  const detail = [
    typeof payload.summary === "string" ? payload.summary : undefined,
    typeof payload.message === "string" ? payload.message : undefined,
    typeof payload.error === "string" ? payload.error : undefined,
    typeof payload.question === "string" ? payload.question : undefined,
    typeof payload.reason === "string" ? payload.reason : undefined,
  ]
    .find((value) => value && value.trim())
    ?.replace(/\s+/g, " ")
    .trim();
  const color =
    message.type === "TASK_FAILED"
      ? "error"
      : message.type === "TASK_COMPLETED"
        ? "success"
        : FIRST_MATE_CONTROL_WARNING_TYPES.has(message.type)
          ? "warning"
          : "accent";
  return (
    theme.fg(color, `${message.taskId} ${label}`) +
    (detail ? theme.fg("muted", ` · ${detail}`) : "")
  );
}

export const renderFirstMateControlMessage: MessageRenderer = (
  message,
  options,
  theme,
) => {
  const details = (message.details ?? {}) as Partial<FleetMessage>;
  if (
    typeof details.taskId !== "string" ||
    typeof details.type !== "string" ||
    !details.payload ||
    typeof details.payload !== "object"
  )
    return new Text(
      typeof message.content === "string" ? message.content : "",
      0,
      0,
    );
  const fleetMessage = details as FleetMessage;
  const summary = firstMateControlSummary(fleetMessage, theme);
  if (!options.expanded) return new Text(summary, 0, 0);
  const content = typeof message.content === "string" ? message.content : "";
  return new Text(`${summary}\n${content}`, 0, 0);
};

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
  const candidates = ctx.modelRegistry
    .getAll()
    .filter((model) => `${model.provider}/${model.id}` === requested);
  if (candidates.length === 0)
    throw new Error(`Approved Pi model is unavailable: ${requested}`);
  for (const model of candidates) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok) return `${model.provider}/${model.id}`;
  }
  throw new Error(`Pi model is configured but unauthenticated: ${requested}`);
}

function commandHelp(kind: "ps" | "subagents") {
  const noun = kind === "ps" ? "background task" : "subagent";
  return `${kind}: list | output <id> | focus <id> | send <id> <text> | keys <id> <key...> | interrupt <id> | pin <id> | unpin <id> | close <id>${kind === "subagents" ? " | attach <id>" : ""}\nActions only affect tracked ${noun} resources.`;
}

export class CompletionSuppression {
  private readonly counts = new Map<string, number>();

  acquire(ids: string[]) {
    for (const id of ids) this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = this.counts.get(id) ?? 0;
        if (count <= 1) this.counts.delete(id);
        else this.counts.set(id, count - 1);
      }
    };
  }

  has(id: string) {
    return this.counts.has(id);
  }
}

function deliveredFleetMessageIds(ctx: ExtensionContext) {
  const ids = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "custom_message" ||
      entry.customType !== "first-mate-control" ||
      !entry.details ||
      typeof entry.details !== "object"
    )
      continue;
    const id = (entry.details as Record<string, unknown>).id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function sendTaskResult(
  pi: ExtensionAPI,
  message: {
    content: string;
    id: string;
    kind: string;
    status: string;
    label: string;
  },
) {
  try {
    pi.sendMessage(
      {
        customType: "herdr-task-result",
        content: message.content,
        display: true,
        details: {
          id: message.id,
          kind: message.kind,
          status: message.status,
          label: message.label,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    /* Task results remain available in the registry and result files. */
  }
}

export function deliverTaskCompletion(
  pi: ExtensionAPI,
  suppression: CompletionSuppression,
  task: TaskRecord,
  output: string,
) {
  if (suppression.has(task.id)) return false;
  sendTaskResult(pi, {
    content: `${task.kind} ${task.id} “${task.label}” ${task.status}.\n\n${output}`,
    id: task.id,
    kind: task.kind,
    status: task.status,
    label: task.label,
  });
  return true;
}

type SubagentWaitManager = Pick<OrchestrationManager, "wait" | "report">;

export function registerWaitableSubagent(
  backgroundWaits: BackgroundWaitRegistry,
  manager: SubagentWaitManager,
  suppression: CompletionSuppression,
  task: TaskRecord,
) {
  if (task.kind !== "subagent") return;
  backgroundWaits.register({
    id: task.id,
    label: task.label,
    kind: "subagent",
    async wait(signal) {
      const release = suppression.acquire([task.id]);
      try {
        const [settled] = await manager.wait([task.id], signal);
        if (!settled) throw new Error(`Unknown subagent ${task.id}.`);
        return {
          status: settled.status,
          successful: settled.status === "done",
          output: await manager.report(settled.id),
          details: settled,
        };
      } finally {
        release();
      }
    },
  });
}

export function registerSubagentWait(
  pi: ExtensionAPI,
  backgroundWaits: BackgroundWaitRegistry,
  executeBackgroundWait: BackgroundWaitExecutor,
) {
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Herdr Subagents",
    description:
      "Yield the current turn while waiting in the background for one or more child results. A combined result automatically starts a new turn when all requested children settle.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_call, params, signal) {
      const ids = [...new Set(params.ids)];
      const invalid = ids.filter(
        (id) => backgroundWaits.get(id)?.kind !== "subagent",
      );
      if (invalid.length)
        throw new Error(`Unknown subagent ${invalid.join(", ")}.`);
      return executeBackgroundWait(ids, signal);
    },
    ...compactSubagentRendering(
      (args: { ids: string[] }) => `subagent wait ${args.ids.join(", ")}`,
    ),
  });
}

export default function orchestration(pi: ExtensionAPI) {
  const registry = new TaskRegistry();
  const completionSuppression = new CompletionSuppression();
  const backgroundWaits = getBackgroundWaitRegistry(pi);
  const executeBackgroundWait = registerBackgroundWaitTool(pi, backgroundWaits);
  let context: ExtensionContext | undefined;
  const herdr = new HerdrClient(nodeCliRunner);
  const firstMateTodoPane = new FirstMateTodoPaneController(herdr);
  let fleetForCallbacks: FleetManager | undefined;
  const manager = new OrchestrationManager(
    herdr,
    new TreehouseClient(nodeCliRunner),
    registry,
    {
      onComplete(task, output) {
        deliverTaskCompletion(pi, completionSuppression, task, output);
      },
      onChange() {
        void updateStatus();
        void fleetForCallbacks?.refreshMetadata().catch(() => undefined);
      },
    },
  );
  const fleetStore = new FleetStore();
  const fleet = new FleetManager(fleetStore, herdr, manager);
  fleetForCallbacks = fleet;
  let fleetPoll: ReturnType<typeof setInterval> | undefined;
  let firstMateTodoPoll: ReturnType<typeof setInterval> | undefined;
  let fleetPollRunning = false;
  let deliveredFleetMessages = new Set<string>();
  let sessionId: string | undefined;
  const orchestrationRole = process.env.PI_FIRST_MATE_ROLE;
  let mateTaskId =
    orchestrationRole === "second-mate"
      ? process.env.PI_FIRST_MATE_TASK_ID
      : undefined;

  async function pollFleetInbox() {
    if (!sessionId || fleetPollRunning) return;
    fleetPollRunning = true;
    try {
      await fleet.heartbeatFirstMate(sessionId);
      const messages = await fleet.pendingFor(sessionId, mateTaskId);
      for (const message of messages) {
        if (deliveredFleetMessages.has(message.id)) {
          await fleet.acknowledge(message.id, sessionId, "duplicate");
          continue;
        }
        if (message.type === "TASK_ASSIGNED" && mateTaskId) {
          await fleet.acknowledge(message.id, sessionId);
          void updateStatus();
          continue;
        }
        if (message.type === "TASK_ACCEPTED") {
          const location = await herdr.current();
          await fleet.registerOwnerPane(
            message.taskId,
            sessionId,
            location.paneId,
          );
          await fleet.acknowledge(message.id, sessionId);
          void updateStatus();
          continue;
        }
        pi.sendMessage(
          {
            customType: "first-mate-control",
            content: formatFleetMessage(message),
            display: true,
            details: message,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        deliveredFleetMessages.add(message.id);
        await fleet.acknowledge(message.id, sessionId);
        void updateStatus();
      }
    } finally {
      fleetPollRunning = false;
    }
  }

  registerAutoReload(pi, {
    hasActiveWait: () => backgroundWaits.hasActiveWaits(),
    async hasRunningTasks(sessionId) {
      const tasks = await manager.list(sessionId);
      return tasks.some(
        (task) => task.status === "running" || task.status === "starting",
      );
    },
  });

  async function updateStatus() {
    if (!context?.hasUI) return;
    const tasks = await manager
      .list(context.sessionManager.getSessionId())
      .catch(() => []);
    const running = tasks.filter(
      (task) => task.status === "running" || task.status === "starting",
    ).length;
    const failed = tasks.filter((task) => needsInspection(task)).length;
    const fleetTasks = await fleet
      .list(context.sessionManager.getSessionId())
      .catch(() => []);
    const activeTasks = fleetTasks.filter(
      (task) =>
        task.state !== "completed" &&
        task.state !== "failed" &&
        task.state !== "cancelled",
    ).length;
    const decisions = fleetTasks.filter(
      (task) => task.state === "waiting-decision",
    ).length;
    context.ui.setStatus(
      "herdr-orchestration",
      running || failed || activeTasks || decisions
        ? context.ui.theme.fg(
            failed || decisions ? "warning" : "muted",
            `Herdr: ${activeTasks} tasks · ${running} workers${decisions ? ` · ${decisions} decisions` : ""}${failed ? ` · ${failed} inspect` : ""}`,
          )
        : undefined,
    );
  }

  async function syncFirstMateTodoPane(ctx: ExtensionContext) {
    if (mateTaskId || process.env.HERDR_ENV !== "1") return;
    const status = await fleet.firstMateStatus();
    if (status.lease?.sessionId !== ctx.sessionManager.getSessionId()) return;
    const location = await herdr.current();
    await firstMateTodoPane.ensure({
      workspaceId: location.workspaceId,
      tabId: location.tabId,
      paneId: location.paneId,
      cwd: ctx.cwd,
    });
  }

  async function claimCurrentFirstMate(ctx: ExtensionContext) {
    if (mateTaskId)
      throw new Error(
        `This session is already the second mate for ${mateTaskId} and cannot become first mate.`,
      );
    const location = await herdr.current();
    const lease = await fleet.claimFirstMate({
      sessionId: ctx.sessionManager.getSessionId(),
      workspaceId: location.workspaceId,
      tabId: location.tabId,
      paneId: location.paneId,
      cwd: ctx.cwd,
    });
    await syncFirstMateTodoPane(ctx).catch(() => undefined);
    await pollFleetInbox();
    const tasks = await fleet.list(lease.sessionId);
    return { lease, tasks };
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    deliveredFleetMessages = deliveredFleetMessageIds(ctx);
    const registeredTaskId = mateTaskId;
    if (registeredTaskId) {
      try {
        const location = await herdr.current();
        await fleet.registerMate({
          taskId: registeredTaskId,
          sessionId: sessionId!,
          workspaceId: location.workspaceId,
          tabId: location.tabId,
          paneId: location.paneId,
        });
        await pollFleetInbox();
      } catch (error) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `Second-mate registration failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
      }
    }
    fleetPoll = setInterval(() => {
      void pollFleetInbox().catch(() => undefined);
    }, 1_000);
    fleetPoll.unref?.();
    firstMateTodoPoll = setInterval(() => {
      void syncFirstMateTodoPane(ctx).catch(() => undefined);
    }, 5_000);
    firstMateTodoPoll.unref?.();
    void pollFleetInbox().catch(() => undefined);
    void syncFirstMateTodoPane(ctx).catch(() => undefined);
    void manager
      .reconcile(ctx.sessionManager.getSessionId())
      .then(async () => {
        const tasks = await manager.list(ctx.sessionManager.getSessionId());
        for (const task of tasks)
          registerWaitableSubagent(
            backgroundWaits,
            manager,
            completionSuppression,
            task,
          );
      })
      .catch((error) => {
        if (ctx.hasUI && process.env.HERDR_ENV === "1")
          ctx.ui.notify(
            `Herdr reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
      });
    void updateStatus();
    const disabled = new Set(["workflow"]);
    if (mateTaskId) {
      disabled.add("task_assign");
      disabled.add("task_send");
      disabled.add("task_cancel");
      disabled.add("mate_register");
    }
    pi.setActiveTools(
      pi.getActiveTools().filter((name) => !disabled.has(name)),
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (orchestrationRole === "leaf" || mateTaskId) return;
    const lease = await fleetStore.getFirstMate();
    if (lease?.sessionId !== ctx.sessionManager.getSessionId()) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${FIRST_MATE_SUPERVISORY_PROMPT}`,
    };
  });

  pi.on("tool_call", (event) => {
    if (orchestrationRole !== "leaf" && !mateTaskId) return;
    if (
      isToolCallEventType("bash", event) &&
      /\bherdr\s+(?:workspace\s+create|tab\s+create|pane\s+split|agent\s+start)\b/.test(
        event.input.command,
      )
    )
      return {
        block: true,
        reason:
          "Direct Herdr resource creation is disabled for managed mates and leaves. Use task-owned worker or background-job tools so lifecycle cleanup remains durable.",
      };
  });

  pi.on("input", (event) => {
    if (/\b(workflow|ultracode)\b/i.test(event.text)) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "workflow"])]);
    }
    return { action: "continue" };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    context = undefined;
    sessionId = undefined;
    if (fleetPoll) clearInterval(fleetPoll);
    if (firstMateTodoPoll) clearInterval(firstMateTodoPoll);
    fleetPoll = undefined;
    firstMateTodoPoll = undefined;
    manager.dispose();
    backgroundWaits.dispose();
    if (ctx.hasUI) ctx.ui.setStatus("herdr-orchestration", undefined);
  });

  pi.registerMessageRenderer(
    "first-mate-control",
    renderFirstMateControlMessage,
  );
  pi.registerMessageRenderer("herdr-task-result", renderHerdrTaskResult);

  pi.registerTool({
    name: "first_mate_claim",
    label: "Claim Machine First Mate",
    description: `Explicitly claim the singleton first-mate role for this machine. Refuses while another live first mate owns it; reclaims all tasks and pending outcomes from a dead owner. First-mate sessions default to ${FIRST_MATE_DEFAULT.provider}/${FIRST_MATE_DEFAULT.model} at ${FIRST_MATE_DEFAULT.reasoning} reasoning.`,
    parameters: Type.Object({}),
    async execute(_call, _params, _signal, _update, ctx) {
      const { lease, tasks } = await claimCurrentFirstMate(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Claimed the machine first-mate role for session ${lease.sessionId} in workspace ${lease.workspaceId}. ${tasks.length} task${tasks.length === 1 ? "" : "s"} now belong to this session.`,
          },
        ],
        details: { lease, tasks },
      };
    },
    ...compactFirstMateControlRendering(() => "first mate claim"),
  });

  pi.registerTool({
    name: "first_mate_status",
    label: "Inspect Machine First Mate",
    description:
      "Show which Pi session owns the singleton machine first-mate role and whether its Herdr agent is alive.",
    parameters: Type.Object({}),
    async execute() {
      const status = await fleet.firstMateStatus();
      return {
        content: [
          {
            type: "text",
            text: status.lease
              ? `First mate: ${status.lease.sessionId} · workspace ${status.lease.workspaceId} · ${status.alive ? "alive" : "stale/reclaimable"}`
              : "This machine has no first mate. Use first_mate_claim to claim it.",
          },
        ],
        details: status,
      };
    },
    ...compactFirstMateControlRendering(() => "first mate status"),
  });

  pi.registerTool({
    name: "task_assign",
    label: "Assign Task to Second Mate",
    description:
      "Create a Herdr task Space, start a persistent Pi second mate in its first tab, and assign one task through the durable fleet ledger.",
    promptSnippet:
      "Assign one task to a persistent Pi second mate in its own Herdr Space",
    promptGuidelines: [
      "When the assignment references a Linear issue, pass linear_issue so the second mate gets explicit sync instructions.",
      "Persistent second mates always use direct openai-codex/gpt-5.6-sol at high reasoning; omitted model settings select that policy default and other settings fail.",
    ],
    parameters: Type.Object({
      task_id: Type.String(),
      title: Type.String(),
      brief: Type.String(),
      linear_issue: Type.Optional(
        Type.String({
          description:
            "Linear issue identifier or URL to synchronize while the task is in progress.",
        }),
      ),
      working_dir: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      reasoning_effort: Type.Optional(StringEnum(REASONING_LEVELS)),
    }),
    async execute(_call, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Task assignment cancelled.");
      const ownerLocation = await herdr.current();
      const task = await fleet.assignTask({
        id: params.task_id,
        title: params.title,
        brief: params.brief,
        linearIssue: params.linear_issue,
        cwd: resolvePath(ctx.cwd, params.working_dir ?? "."),
        ownerSessionId: ctx.sessionManager.getSessionId(),
        ownerPaneId: ownerLocation.paneId,
        model: params.model,
        reasoning: params.reasoning_effort as ReasoningLevel | undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: `Assigned ${task.id} “${task.title}” to its second mate in Herdr workspace ${task.workspaceId}.`,
          },
        ],
        details: task,
      };
    },
    ...compactFirstMateControlRendering(
      (args: { task_id: string; title: string }) =>
        `task assign ${args.task_id} ${args.title}`,
    ),
  });

  pi.registerTool({
    name: "task_list",
    label: "List First-Mate Tasks",
    description:
      "List tasks owned by this first-mate session with their second-mate and Herdr workspace state.",
    parameters: Type.Object({}),
    async execute(_call, _params, _signal, _update, ctx) {
      const currentSessionId = ctx.sessionManager.getSessionId();
      await fleet.requireFirstMate(currentSessionId);
      const tasks = await fleet.list(currentSessionId);
      return {
        content: [
          {
            type: "text",
            text: `First-mate session: ${ctx.sessionManager.getSessionId()}\n${
              tasks.length
                ? tasks
                    .map(
                      (task) =>
                        `${task.id} [${task.state}] ${task.title} · workspace ${task.workspaceId ?? "pending"} · mate ${task.mateSessionId ?? "starting"}`,
                    )
                    .join("\n")
                : "No first-mate tasks."
            }`,
          },
        ],
        details: { tasks },
      };
    },
    ...compactFirstMateControlRendering(() => "task list"),
  });

  pi.registerTool({
    name: "task_send",
    label: "Send Second-Mate Control Message",
    description:
      "Send an acknowledged decision, scope, priority, pause, or resume message to a task's second mate.",
    parameters: Type.Object({
      task_id: Type.String(),
      type: StringEnum(FIRST_MATE_MESSAGE_TYPES),
      message: Type.String(),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      const message = await fleet.sendToMate({
        taskId: params.task_id,
        type: params.type,
        fromSessionId: ctx.sessionManager.getSessionId(),
        payload: { message: params.message },
      });
      return {
        content: [
          {
            type: "text",
            text: `Queued ${message.type} ${message.id} for ${message.taskId} sequence ${message.sequence}.`,
          },
        ],
        details: message,
      };
    },
    ...compactFirstMateControlRendering(
      (args: { task_id: string; type: string }) =>
        `task send ${args.task_id} ${args.type}`,
    ),
  });

  pi.registerTool({
    name: "task_cancel",
    label: "Cancel First-Mate Task",
    description:
      "Cancel a task, notify its second mate, and stop all tracked leaf workers and jobs owned by it.",
    parameters: Type.Object({
      task_id: Type.String(),
      reason: Type.String(),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      const message = await fleet.sendToMate({
        taskId: params.task_id,
        type: "CANCEL",
        fromSessionId: ctx.sessionManager.getSessionId(),
        payload: { reason: params.reason },
      });
      return {
        content: [
          {
            type: "text",
            text: `Cancelled ${message.taskId}; its mate was notified and owned resources are stopping.`,
          },
        ],
        details: message,
      };
    },
    ...compactFirstMateControlRendering(
      (args: { task_id: string }) => `task cancel ${args.task_id}`,
    ),
  });

  pi.registerTool({
    name: "mate_register",
    label: "Register Independent Second Mate",
    description:
      "Register the current dedicated Pi session and Herdr workspace as the second mate for one task.",
    parameters: Type.Object({
      task_id: Type.String(),
      title: Type.String(),
      brief: Type.String(),
      linear_issue: Type.Optional(
        Type.String({
          description:
            "Linear issue identifier or URL to synchronize while the task is in progress.",
        }),
      ),
      first_mate_session_id: Type.String(),
      workspace_dedicated: Type.Literal(true, {
        description:
          "Confirm this Herdr workspace is dedicated exclusively to this task.",
      }),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      if (!ctx.model)
        throw new Error(
          "Model policy violation: independent second mates require an active direct openai-codex/gpt-5.6-sol model.",
        );
      resolveSecondMatePolicy({
        model: `${ctx.model.provider}/${ctx.model.id}`,
        reasoning: pi.getThinkingLevel() as ReasoningLevel,
      });
      const location = await herdr.current();
      const task = await fleet.registerIndependent({
        taskId: params.task_id,
        title: params.title,
        brief: params.brief,
        linearIssue: params.linear_issue,
        cwd: ctx.cwd,
        ownerSessionId: params.first_mate_session_id,
        mateSessionId: ctx.sessionManager.getSessionId(),
        workspaceId: location.workspaceId,
        tabId: location.tabId,
        paneId: location.paneId,
      });
      mateTaskId = task.id;
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter(
            (name) =>
              name !== "first_mate_claim" &&
              name !== "first_mate_status" &&
              name !== "task_assign" &&
              name !== "task_list" &&
              name !== "task_send" &&
              name !== "task_cancel" &&
              name !== "mate_register" &&
              name !== "workflow",
          ),
      );
      void pollFleetInbox();
      return {
        content: [
          {
            type: "text",
            text: `Registered this session as second mate for ${task.id} in workspace ${task.workspaceId}.`,
          },
        ],
        details: task,
      };
    },
    ...compactSubagentRendering(
      (args: { task_id: string }) => `mate register ${args.task_id}`,
    ),
  });

  pi.registerTool({
    name: "raise_decision",
    label: "Raise Decision to First Mate",
    description:
      "Escalate a captain-level decision, material risk, or blocker from this second mate to its first mate.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      type: StringEnum(SECOND_MATE_ESCALATIONS),
      summary: Type.String(),
      question: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.String())),
      recommendation: Type.Optional(Type.String()),
      impact: Type.Optional(Type.String()),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      const taskId = params.task_id ?? mateTaskId;
      if (!taskId)
        throw new Error(
          "raise_decision requires task_id outside a registered second-mate session.",
        );
      const message = await fleet.sendToFirstMate({
        taskId,
        type: params.type,
        fromSessionId: ctx.sessionManager.getSessionId(),
        payload: {
          summary: params.summary,
          question: params.question,
          options: params.options,
          recommendation: params.recommendation,
          impact: params.impact,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Raised ${message.type} ${message.id} for ${message.taskId}.`,
          },
        ],
        details: message,
      };
    },
    ...compactSubagentRendering(
      (args: { type: string }) => `mate raise ${args.type}`,
    ),
  });

  pi.registerTool({
    name: "complete_task",
    label: "Complete Second-Mate Task",
    description:
      "Record a verified task outcome, notify the first mate, and stop remaining task-owned jobs and workers.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      summary: Type.String(),
      changes: Type.Optional(Type.Array(Type.String())),
      verification: Type.Optional(Type.Array(Type.String())),
      risks: Type.Optional(Type.Array(Type.String())),
      artifacts: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_call, params, signal, _update, ctx) {
      const taskId = params.task_id ?? mateTaskId;
      if (!taskId)
        throw new Error(
          "complete_task requires task_id outside a registered second-mate session.",
        );
      const workerReports = (await manager.list())
        .filter((task) => task.ownerTaskId === taskId && task.completionReport)
        .map((task) => task.completionReport!);
      const decisions = (await fleet.store.messagesForTask(taskId))
        .filter(
          (message) =>
            message.type === "DECISION_REQUEST" ||
            message.type === "DECISION_RESPONSE",
        )
        .map(
          (message) => `${message.type}: ${JSON.stringify(message.payload)}`,
        );
      let payload = {
        summary: params.summary,
        changes: params.changes ?? [],
        verification: params.verification ?? [],
        risks: params.risks ?? [],
        decisions,
        artifacts: params.artifacts ?? [],
      };
      try {
        const compiled = await compileFleetReports({
          modelRegistry: ctx.modelRegistry,
          reports: [JSON.stringify(payload), ...workerReports],
          signal,
        });
        if (compiled) payload = compiled;
      } catch (error) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `Luna report compilation failed; using the second mate's structured outcome. ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
      }
      const message = await fleet.sendToFirstMate({
        taskId,
        type: "TASK_COMPLETED",
        fromSessionId: ctx.sessionManager.getSessionId(),
        payload,
      });
      return {
        content: [
          {
            type: "text",
            text: `Completed ${message.taskId}; final outcome ${message.id} was queued for the first mate.`,
          },
        ],
        details: message,
      };
    },
    ...compactSubagentRendering(() => "mate complete task"),
  });

  pi.registerTool({
    name: "fail_task",
    label: "Fail Second-Mate Task",
    description:
      "Record an unrecoverable task failure, notify the first mate, and stop remaining task-owned resources.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      summary: Type.String(),
      error: Type.String(),
      recovery: Type.Optional(Type.String()),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      const taskId = params.task_id ?? mateTaskId;
      if (!taskId)
        throw new Error(
          "fail_task requires task_id outside a registered second-mate session.",
        );
      const message = await fleet.sendToFirstMate({
        taskId,
        type: "TASK_FAILED",
        fromSessionId: ctx.sessionManager.getSessionId(),
        payload: {
          summary: params.summary,
          error: params.error,
          recovery: params.recovery,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Failed ${message.taskId}; failure ${message.id} was queued for the first mate.`,
          },
        ],
        details: message,
      };
    },
    ...compactSubagentRendering(() => "mate fail task"),
  });

  pi.registerTool({
    name: "bg_start",
    label: "Start Herdr Background Task",
    description:
      "Start a tracked long-running command or service in a visible Herdr tab without changing focus. Services require a readiness pattern and stop with their owner. Results persist before automatic cleanup.",
    promptSnippet:
      "Start a visible Herdr background command for servers, watchers, long builds, or long tests",
    promptGuidelines: [
      "Use bg_start for long-running commands; use bash for quick commands. Continue useful work after bg_start because completion is delivered automatically.",
      'For polling commands that print repeated status snapshots, print "$PI_BACKGROUND_SNAPSHOT" on its own line immediately before each complete snapshot. Completion delivers only the final marked snapshot; bg_status retains the full history.',
    ],
    parameters: Type.Object({
      command: Type.String(),
      title: Type.String(),
      working_dir: Type.Optional(Type.String()),
      kind: Type.Optional(StringEnum(JOB_KINDS)),
      timeout_seconds: Type.Optional(Type.Number({ minimum: 1 })),
      ready_pattern: Type.Optional(Type.String()),
      readiness_timeout_seconds: Type.Optional(Type.Number({ minimum: 1 })),
      placement: Type.Optional(StringEnum(TAB_PLACEMENTS)),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("bg_start cancelled.");
      const task = await manager.startBackground({
        command: params.command,
        label: params.title,
        cwd: resolvePath(ctx.cwd, params.working_dir ?? "."),
        placement: params.placement ?? "auto",
        parentSession: ctx.sessionManager.getSessionId(),
        ownerTaskId: mateTaskId,
        jobKind: params.kind ?? "finite",
        timeoutMs:
          params.timeout_seconds === undefined
            ? undefined
            : params.timeout_seconds * 1_000,
        readyPattern: params.ready_pattern,
        readinessTimeoutMs:
          params.readiness_timeout_seconds === undefined
            ? undefined
            : params.readiness_timeout_seconds * 1_000,
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
      "Send Ctrl+C to tracked background commands. Their panes close automatically after the cleanup grace period.",
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
                  `Interrupted ${task.id}; its Herdr resource will close automatically.`,
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
    name: "resource_pin",
    label: "Pin Herdr Resource",
    description:
      "Explicitly retain or release a tracked task workspace, settled job, or worker tab. Focusing alone only postpones cleanup.",
    parameters: Type.Object({
      id: Type.String(),
      pinned: Type.Boolean(),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      const fleetTask = await fleet.store.getTask(params.id);
      const task = fleetTask
        ? await fleet.setPinned(
            params.id,
            params.pinned,
            ctx.sessionManager.getSessionId(),
          )
        : await manager.setPinned(params.id, params.pinned);
      return {
        content: [
          {
            type: "text",
            text: `${task.id} is ${params.pinned ? "pinned" : "eligible for automatic cleanup"}.`,
          },
        ],
        details: task,
      };
    },
    ...compactSubagentRendering(
      (args: { id: string; pinned: boolean }) =>
        `${args.pinned ? "pin" : "unpin"} ${args.id}`,
    ),
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
      "Set role to review and review_target_model for reviewers. Reviewers must use a different model family, remain strictly scoped, and be actively monitored; highly reliable work also gets a Grok 4.6 secondary review after the default Sol/Fable cross-review.",
    ],
    parameters: Type.Object({
      prompt: Type.String(),
      name: Type.String(),
      harness: StringEnum(HARNESSES),
      role: Type.Optional(StringEnum(WORKER_ROLES)),
      working_dir: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      reasoning_effort: Type.Optional(StringEnum(REASONING_LEVELS)),
      review_target_model: Type.Optional(
        Type.String({
          description:
            "Required for review workers; the model whose output or changes are being reviewed.",
        }),
      ),
      isolation: Type.Optional(StringEnum(ISOLATIONS)),
      placement: Type.Optional(StringEnum(TAB_PLACEMENTS)),
    }),
    async execute(_call, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Subagent spawn cancelled.");
      const policy = resolveWorkerPolicy({
        role: params.role as WorkerRole | undefined,
        harness: params.harness as Harness,
        model: params.model,
        reasoning: params.reasoning_effort as ReasoningLevel | undefined,
        reviewTargetModel: params.review_target_model,
      });
      const model =
        params.harness === "pi"
          ? await resolvePiModel(ctx, policy.model)
          : policy.model;
      const task = await manager.spawnLeaf({
        prompt: params.prompt,
        label: params.name,
        harness: params.harness as Harness,
        role: policy.role,
        cwd: resolvePath(ctx.cwd, params.working_dir ?? "."),
        model,
        reasoning: policy.reasoning,
        reviewTargetModel: params.review_target_model,
        isolation: params.isolation ?? "auto",
        placement: params.placement ?? "auto",
        parentSession: ctx.sessionManager.getSessionId(),
        ownerTaskId: mateTaskId,
      });
      registerWaitableSubagent(
        backgroundWaits,
        manager,
        completionSuppression,
        task,
      );
      return {
        content: [
          {
            type: "text",
            text: `Spawned ${describe(task)}. Task ID ${task.id} is registered for background_wait. Continue useful work; the result will be delivered automatically.`,
          },
        ],
        details: task,
      };
    },
    ...compactSubagentRendering(
      (args: { name: string }) => `subagent spawn ${args.name}`,
    ),
  });

  registerSubagentWait(pi, backgroundWaits, executeBackgroundWait);
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
      "Interrupt child agents. Their visible resources close automatically after the cleanup grace period.",
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
                  `Cancelled ${task.id}; its resource will close automatically.`,
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
      "Send a follow-up prompt to a tracked child. Cancels pending successful auto-close. Headless workers accept follow-ups only after the current turn settles; wait for the worker instead of sending mid-turn.",
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
    else if (action === "pin") await manager.setPinned(taskId, true);
    else if (action === "unpin") await manager.setPinned(taskId, false);
    else if (action === "close") await manager.close(taskId);
    else if (action === "attach" && kind === "subagents")
      await manager.attach(taskId);
    else ctx.ui.notify(commandHelp(kind), "warning");
  }

  pi.registerCommand("firstmate", {
    description: "Claim, reclaim, or inspect the machine first-mate role",
    handler: async (args, ctx) => {
      try {
        const action = args.trim() || "status";
        if (action === "claim") {
          const { lease, tasks } = await claimCurrentFirstMate(ctx);
          ctx.ui.notify(
            `First mate claimed by ${lease.sessionId}; adopted ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`,
            "info",
          );
          return;
        }
        if (action === "status") {
          const status = await fleet.firstMateStatus();
          ctx.ui.notify(
            status.lease
              ? `First mate ${status.lease.sessionId} in ${status.lease.workspaceId} is ${status.alive ? "alive" : "stale and reclaimable"}.`
              : "No first mate is claimed. Run /firstmate claim.",
            "info",
          );
          return;
        }
        ctx.ui.notify("Usage: /firstmate [status|claim]", "warning");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "warning",
        );
      }
    },
  });

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
