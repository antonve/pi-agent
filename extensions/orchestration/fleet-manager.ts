import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { ReasoningLevel } from "./domain.ts";
import {
  type FleetMessage,
  type FleetMessageType,
  FleetStore,
  type FleetTask,
  type FleetTaskState,
} from "./fleet.ts";
import { HerdrClient } from "./herdr-client.ts";
import type { OrchestrationManager } from "./manager.ts";
import { resolveSecondMatePolicy } from "../shared/model-policy.ts";

const execFileAsync = promisify(execFile);

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TERMINAL_STATES = new Set<FleetTaskState>([
  "completed",
  "failed",
  "cancelled",
]);

export const TASK_WORKSPACE_CLOSE_MS = 30_000;
export const FIRST_MATE_HEARTBEAT_STALE_MS = 15_000;
export const FIRST_MATE_RECLAIM_GRACE_MS = 5 * 60_000;

export interface AssignTaskOptions {
  id: string;
  title: string;
  brief: string;
  linearIssue?: string;
  cwd: string;
  ownerSessionId: string;
  ownerPaneId?: string;
  model?: string;
  reasoning?: ReasoningLevel;
}

const LINEAR_ISSUE_IDENTIFIER = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const LINEAR_ISSUE_URL =
  /\bhttps:\/\/(?:app\.)?linear\.app\/[^\s/]+\/issue\/([A-Z][A-Z0-9]+-\d+)(?:\b|\/[^\s]*)/i;

function cleanTitle(title: string) {
  return title.replace(/\s+/g, " ").trim().slice(0, 80) || "task";
}

async function repositoryBasename(cwd: string) {
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd,
        timeout: 5_000,
        env: process.env,
      },
    );
    const root = result.stdout.trim();
    if (root) return basename(root);
  } catch {
    /* Fall back to the current working directory basename. */
  }
  return basename(resolve(cwd));
}

function mateAgentName(taskId: string) {
  const clean = taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 26);
  return `mate-${clean || randomUUID().slice(0, 8)}`;
}

export function parseLinearIssueReference(value: string) {
  const urlMatch = value.match(LINEAR_ISSUE_URL);
  if (urlMatch?.[1]) return urlMatch[1].toUpperCase();
  const identifierMatch = value.match(LINEAR_ISSUE_IDENTIFIER);
  if (identifierMatch?.[1]) return identifierMatch[1].toUpperCase();
  return undefined;
}

function resolveLinearIssueReference(options: {
  linearIssue?: string;
  taskId?: string;
  title: string;
  brief: string;
}) {
  if (options.linearIssue) {
    const explicit = parseLinearIssueReference(options.linearIssue.trim());
    if (!explicit)
      throw new Error(
        `Linear issue must be an identifier like ENG-123 or a Linear issue URL; received ${options.linearIssue}.`,
      );
    return explicit;
  }
  return parseLinearIssueReference(
    `${options.taskId ?? ""}\n${options.title}\n${options.brief}`,
  );
}

export function buildManagedLinearPlanCommentMarker(
  task: Pick<FleetTask, "id" | "linearIssue">,
) {
  if (!task.linearIssue)
    throw new Error("Managed Linear plan comments require a Linear issue.");
  return `<!-- pi-linear-sync task=${task.id} issue=${task.linearIssue} -->`;
}

function buildWorkspaceLabel(
  task: Pick<FleetTask, "id" | "title" | "linearIssue">,
) {
  return `${task.linearIssue ?? task.id} ${task.title}`;
}

function buildLinearSyncPrompt(task: FleetTask) {
  if (!task.linearIssue) return "";
  return `

Linear synchronization:
- This task is linked to Linear issue ${task.linearIssue}.
- Before planning, read the issue with linear_get_issue.
- When work begins, move the issue to the team’s started workflow state.
- Preserve the issue description and any human-authored content.
- Maintain exactly one managed living-plan comment whose first line is ${buildManagedLinearPlanCommentMarker(task)}.
- If that managed comment already exists, update it instead of creating another; create it once with linear_add_comment, then use linear_graphql to edit that same comment when the plan or checkbox progress changes.
- Add concise material decisions, blockers, and outcome context to that same managed comment.
- Prefer linear_get_issue, linear_list_resources, linear_update_issue, and linear_add_comment; use linear_graphql only as the fallback for editing the managed comment.
- Leave blocked or failed work open with an explanatory update.
- Move the issue to completed only after verified success and immediately before complete_task.`;
}

export function buildSecondMatePrompt(task: FleetTask) {
  return `You are the second mate responsible for exactly one task.

Task: ${task.id} — ${task.title}
Working directory: ${task.cwd}

${task.brief.trim()}${buildLinearSyncPrompt(task)}

Ownership rules:
- Own this task through planning, delegation, verification, and final reporting.
- Own the detailed plan, including creating and updating any \`~/xdev/plans\` file needed for this task.
- Keep detailed task and worker context in this session and preserve the implementation context needed for follow-through.
- Own detailed Linear ticket context and task-specific Linear discovery and writes; report upward only concise issue identifiers and outcomes.
- Use headless leaf workers for self-contained delegated work.
- Give every leaf a narrow written scope and expected output, actively monitor its progress, and redirect or cancel drift.
- Reject leaf suggestions that expand the assigned scope; escalate material scope changes to the first mate instead.
- Mark review workers with the review role and state the reviewed model so different-family enforcement and the strict review scope guard apply.
- Do not create other second mates or task workspaces.
- Raise only captain-level decisions, material risks, scope changes, and unrecoverable blockers to the first mate.
- Do not copy worker transcripts upward; send concise decisions, risks, and outcomes.
- Ensure all long-running commands are managed jobs and stop task-owned services before completion.
- For repository-changing work, verify the change, commit it, push it, open a review-ready PR unless explicitly told to stay local-only, include the PR URL in complete_task, and retain the Treehouse lease for review follow-up.
- If user decisions still leave expected implementation or follow-up work, keep the task active or resume it rather than terminally completing it and losing ownership/context.
- Call complete_task or fail_task exactly once when the task truly reaches a terminal outcome.`;
}

export function formatFleetMessage(message: FleetMessage) {
  const payload = JSON.stringify(message.payload, null, 2);
  return `[First-mate control message ${message.id}]
Task: ${message.taskId}
Type: ${message.type}
Sequence: ${message.sequence}
Payload:
${payload}`;
}

export class FleetManager {
  readonly store: FleetStore;
  readonly herdr: HerdrClient;
  private readonly orchestration: OrchestrationManager;

  constructor(
    store: FleetStore,
    herdr: HerdrClient,
    orchestration: OrchestrationManager,
  ) {
    this.store = store;
    this.herdr = herdr;
    this.orchestration = orchestration;
  }

  private async preserveFocus<T>(
    owner:
      | {
          workspaceId: string;
          paneId: string;
        }
      | undefined,
    operation: () => Promise<T>,
  ) {
    const shouldRestore = owner
      ? await this.herdr
          .workspaceIsFocused(owner.workspaceId)
          .catch(() => false)
      : false;
    try {
      return await operation();
    } finally {
      if (shouldRestore && owner) {
        const stillFocused = await this.herdr
          .workspaceIsFocused(owner.workspaceId)
          .catch(() => false);
        if (!stillFocused)
          await this.herdr.focusPane(owner.paneId).catch(() => undefined);
      }
    }
  }

  async claimFirstMate(options: {
    sessionId: string;
    workspaceId: string;
    tabId: string;
    paneId: string;
    cwd: string;
  }) {
    const current = await this.store.getFirstMate();
    if (current && current.sessionId !== options.sessionId) {
      const heartbeatFresh =
        Date.now() - current.updatedAt < FIRST_MATE_HEARTBEAT_STALE_MS;
      const alive =
        heartbeatFresh || (await this.herdr.agentExists(current.paneId));
      if (alive)
        throw new Error(
          `First mate is already owned by live session ${current.sessionId} in workspace ${current.workspaceId}.`,
        );
    }
    const lease = await this.store.claimFirstMate({
      sessionId: options.sessionId,
      workspaceId: options.workspaceId,
      tabId: options.tabId,
      paneId: options.paneId,
      expectedSessionId: current?.sessionId,
    });
    await this.preserveFocus(
      { workspaceId: options.workspaceId, paneId: options.paneId },
      async () => {
        await this.herdr.renameWorkspace(lease.workspaceId, "firstmate");
        await this.herdr.renameTab(lease.tabId, "firstmate");
        await this.herdr.moveWorkspace(lease.workspaceId, 0);
        await this.publishFirstMateMetadata(lease.workspaceId, options.cwd);
        await this.refreshMetadata();
      },
    );
    return lease;
  }

  async firstMateStatus() {
    const lease = await this.store.getFirstMate();
    if (!lease) return { lease: undefined, alive: false };
    const heartbeatFresh =
      Date.now() - lease.updatedAt < FIRST_MATE_HEARTBEAT_STALE_MS;
    const alive =
      heartbeatFresh ||
      (await this.herdr.agentExists(lease.paneId).catch(() => true));
    return { lease, alive };
  }

  heartbeatFirstMate(sessionId: string) {
    return this.store.touchFirstMate(sessionId);
  }

  async requireFirstMate(sessionId: string) {
    const lease = await this.store.getFirstMate();
    if (!lease)
      throw new Error(
        "This machine has no first mate. Claim it with first_mate_claim before managing tasks.",
      );
    if (lease.sessionId !== sessionId)
      throw new Error(
        `First mate is owned by session ${lease.sessionId}; this session must not manage its portfolio.`,
      );
    return lease;
  }

  async assignTask(options: AssignTaskOptions) {
    const lease = await this.requireFirstMate(options.ownerSessionId);
    if (!TASK_ID.test(options.id))
      throw new Error(
        "Task ID must start with a letter or number and contain at most 64 letters, numbers, dots, underscores, or hyphens.",
      );
    const title = cleanTitle(options.title);
    const linearIssue = resolveLinearIssueReference({
      taskId: options.id,
      linearIssue: options.linearIssue,
      title: options.title,
      brief: options.brief,
    });
    const cwd = resolve(options.cwd);
    const modelPolicy = resolveSecondMatePolicy({
      model: options.model,
      reasoning: options.reasoning,
    });
    const repoBasename = await repositoryBasename(cwd);
    let task = await this.store.createTask({
      id: options.id,
      title,
      brief: options.brief.trim(),
      linearIssue,
      cwd,
      repoBasename,
      state: "assigning",
      ownerSessionId: options.ownerSessionId,
      ownerPaneId: options.ownerPaneId,
    });
    let workspaceId: string | undefined;
    return this.preserveFocus(
      {
        workspaceId: lease.workspaceId,
        paneId: options.ownerPaneId ?? lease.paneId,
      },
      async () => {
        try {
          const workspace = await this.herdr.createTaskWorkspace(
            cwd,
            buildWorkspaceLabel(task),
            {
              PI_FIRST_MATE_ROLE: "second-mate",
              PI_FIRST_MATE_TASK_ID: task.id,
              PI_FIRST_MATE_OWNER_SESSION_ID: options.ownerSessionId,
            },
          );
          workspaceId = workspace.workspaceId;
          await this.herdr.renameTab(workspace.tabId, "secondmate");
          const agentName = mateAgentName(task.id);
          task = await this.store.updateTask(task.id, {
            workspaceId: workspace.workspaceId,
            mateTabId: workspace.tabId,
            matePaneId: workspace.paneId,
            mateAgentName: agentName,
          });
          await this.publishMetadata(task);
          const assignment = await this.store.enqueue({
            taskId: task.id,
            type: "TASK_ASSIGNED",
            fromSessionId: options.ownerSessionId,
            toTaskMate: true,
            payload: {
              title: task.title,
              brief: task.brief,
              linearIssue: task.linearIssue,
              cwd: task.cwd,
            },
          });
          const args = [
            "--session-id",
            randomUUID(),
            "--name",
            `${task.id} second mate`,
            "--model",
            modelPolicy.model,
            "--thinking",
            modelPolicy.reasoning,
            "--exclude-tools",
            "first_mate_claim,first_mate_status,task_assign,task_list,task_send,task_cancel,mate_register,workflow",
          ];
          await this.herdr.startAgent(agentName, "pi", workspace.paneId, args);
          await this.herdr.deliverInitialPrompt({
            name: agentName,
            harness: "pi",
            paneId: workspace.paneId,
            launchArgs: args,
            prompt: `${buildSecondMatePrompt(task)}\n\nAssignment envelope: ${assignment.id}`,
          });
          const registered = await this.store.getTask(task.id);
          task = await this.store.updateTask(task.id, {
            state: registered?.mateSessionId ? "active" : "assigned",
          });
          await this.publishMetadata(task);
          return task;
        } catch (error) {
          task = await this.store.updateTask(task.id, {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          if (workspaceId)
            await this.herdr.closeWorkspace(workspaceId).catch(() => undefined);
          throw error;
        }
      },
    );
  }

  async registerMate(options: {
    taskId: string;
    sessionId: string;
    workspaceId: string;
    tabId: string;
    paneId: string;
  }) {
    const task = await this.requireTask(options.taskId);
    const firstRegistration = task.mateSessionId === undefined;
    if (task.workspaceId && task.workspaceId !== options.workspaceId)
      throw new Error(
        `Task ${task.id} belongs to Herdr workspace ${task.workspaceId}, not ${options.workspaceId}.`,
      );
    await this.herdr.renameTab(options.tabId, "secondmate");
    const updated = await this.store.updateTask(task.id, {
      mateSessionId: options.sessionId,
      workspaceId: options.workspaceId,
      mateTabId: options.tabId,
      matePaneId: options.paneId,
      state:
        task.state === "assigning" || task.state === "assigned"
          ? "active"
          : task.state,
    });
    await this.publishMetadata(updated);
    for (const message of await this.store.pendingFor(
      options.sessionId,
      options.taskId,
    )) {
      if (message.type === "TASK_ASSIGNED")
        await this.store.acknowledge(message.id, options.sessionId);
    }
    if (firstRegistration)
      await this.store.enqueue({
        taskId: updated.id,
        type: "TASK_ACCEPTED",
        fromSessionId: options.sessionId,
        toSessionId: updated.ownerSessionId,
        payload: { mateSessionId: options.sessionId },
      });
    return updated;
  }

  async registerOwnerPane(
    taskId: string,
    ownerSessionId: string,
    ownerPaneId: string,
  ) {
    const task = await this.requireOwnedTask(taskId, ownerSessionId);
    return this.store.updateTask(task.id, { ownerPaneId });
  }

  async registerIndependent(options: {
    taskId: string;
    title: string;
    brief: string;
    linearIssue?: string;
    cwd: string;
    ownerSessionId: string;
    mateSessionId: string;
    workspaceId: string;
    tabId: string;
    paneId: string;
  }) {
    await this.requireFirstMate(options.ownerSessionId);
    const existing = await this.store.getTask(options.taskId);
    if (existing)
      return this.registerMate({
        taskId: existing.id,
        sessionId: options.mateSessionId,
        workspaceId: options.workspaceId,
        tabId: options.tabId,
        paneId: options.paneId,
      });
    const cwd = resolve(options.cwd);
    const task = await this.store.createTask({
      id: options.taskId,
      title: cleanTitle(options.title),
      brief: options.brief.trim(),
      linearIssue: resolveLinearIssueReference({
        taskId: options.taskId,
        linearIssue: options.linearIssue,
        title: options.title,
        brief: options.brief,
      }),
      cwd,
      repoBasename: await repositoryBasename(cwd),
      state: "active",
      ownerSessionId: options.ownerSessionId,
      mateSessionId: options.mateSessionId,
      workspaceId: options.workspaceId,
      mateTabId: options.tabId,
      matePaneId: options.paneId,
    });
    await this.herdr.renameWorkspace(
      options.workspaceId,
      buildWorkspaceLabel(task),
    );
    await this.herdr.renameTab(options.tabId, "secondmate");
    await this.publishMetadata(task);
    await this.store.enqueue({
      taskId: task.id,
      type: "TASK_ACCEPTED",
      fromSessionId: options.mateSessionId,
      toSessionId: options.ownerSessionId,
      payload: { mateSessionId: options.mateSessionId, independent: true },
    });
    return task;
  }

  async sendToMate(options: {
    taskId: string;
    type: Extract<
      FleetMessageType,
      | "DECISION_RESPONSE"
      | "SCOPE_UPDATE"
      | "PRIORITY_UPDATE"
      | "PAUSE"
      | "RESUME"
      | "CANCEL"
    >;
    fromSessionId: string;
    payload: Record<string, unknown>;
  }) {
    await this.requireFirstMate(options.fromSessionId);
    const task = await this.requireOwnedTask(
      options.taskId,
      options.fromSessionId,
    );
    const message = await this.store.enqueue({
      taskId: task.id,
      type: options.type,
      fromSessionId: options.fromSessionId,
      toSessionId: task.mateSessionId,
      toTaskMate: true,
      payload: options.payload,
    });
    const state: FleetTaskState | undefined =
      options.type === "PAUSE"
        ? "paused"
        : options.type === "RESUME" || options.type === "DECISION_RESPONSE"
          ? "active"
          : options.type === "CANCEL"
            ? "cancelled"
            : undefined;
    if (state) {
      const updated = await this.store.updateTask(task.id, {
        state,
        ...(TERMINAL_STATES.has(state)
          ? { cleanupAt: Date.now() + TASK_WORKSPACE_CLOSE_MS }
          : {}),
      });
      await this.publishMetadata(updated);
    }
    if (options.type === "CANCEL") await this.stopTaskResources(task.id);
    return message;
  }

  async sendToFirstMate(options: {
    taskId: string;
    type: Extract<
      FleetMessageType,
      | "TASK_ACCEPTED"
      | "DECISION_REQUEST"
      | "MATERIAL_RISK"
      | "TASK_BLOCKED"
      | "TASK_COMPLETED"
      | "TASK_FAILED"
    >;
    fromSessionId: string;
    payload: Record<string, unknown>;
  }) {
    const task = await this.requireMateTask(
      options.taskId,
      options.fromSessionId,
    );
    const state: FleetTaskState =
      options.type === "DECISION_REQUEST"
        ? "waiting-decision"
        : options.type === "TASK_BLOCKED"
          ? "blocked"
          : options.type === "TASK_COMPLETED"
            ? "completed"
            : options.type === "TASK_FAILED"
              ? "failed"
              : "active";
    const updated = await this.store.updateTask(task.id, {
      state,
      ...(TERMINAL_STATES.has(state)
        ? { cleanupAt: Date.now() + TASK_WORKSPACE_CLOSE_MS }
        : {}),
    });
    await this.publishMetadata(updated);
    const message = await this.store.enqueue({
      taskId: task.id,
      type: options.type,
      fromSessionId: options.fromSessionId,
      toSessionId: task.ownerSessionId,
      payload: options.payload,
    });
    if (TERMINAL_STATES.has(state)) await this.stopTaskResources(task.id);
    return message;
  }

  pendingFor(sessionId: string, mateTaskId?: string) {
    return this.store.pendingFor(sessionId, mateTaskId);
  }

  acknowledge(
    messageId: string,
    sessionId: string,
    disposition: "accepted" | "duplicate" | "rejected" = "accepted",
  ) {
    return this.store.acknowledge(messageId, sessionId, disposition);
  }

  async refreshMetadata(taskId?: string) {
    const tasks = await this.store.listTasks();
    await Promise.all(
      tasks
        .filter((task) => taskId === undefined || task.id === taskId)
        .map((task) => this.publishMetadata(task)),
    );
  }

  async setPinned(taskId: string, pinned: boolean, sessionId: string) {
    const task = await this.requireTask(taskId);
    if (task.ownerSessionId !== sessionId && task.mateSessionId !== sessionId)
      throw new Error(
        `Session ${sessionId} does not own or supervise fleet task ${taskId}.`,
      );
    const updated = await this.store.updateTask(task.id, {
      pinned,
      ...(pinned
        ? { cleanupAt: undefined }
        : TERMINAL_STATES.has(task.state)
          ? { cleanupAt: Date.now() + TASK_WORKSPACE_CLOSE_MS }
          : {}),
    });
    await this.publishMetadata(updated);
    return updated;
  }

  list(ownerSessionId?: string) {
    return this.store
      .listTasks()
      .then((tasks) =>
        ownerSessionId
          ? tasks.filter((task) => task.ownerSessionId === ownerSessionId)
          : tasks,
      );
  }

  private async stopTaskResources(taskId: string) {
    const resources = (await this.orchestration.list()).filter(
      (task) =>
        task.ownerTaskId === taskId &&
        (task.status === "starting" ||
          task.status === "running" ||
          task.status === "blocked"),
    );
    await Promise.all(
      resources.map((resource) =>
        this.orchestration.cancel(resource.id).catch(() => undefined),
      ),
    );
  }

  private async publishFirstMateMetadata(workspaceId: string, cwd: string) {
    await this.herdr
      .reportWorkspaceMetadata(workspaceId, "pi-first-mate", {
        repo: await repositoryBasename(cwd),
      })
      .catch(() => undefined);
  }

  private async publishMetadata(task: FleetTask) {
    if (!task.workspaceId) return;
    const status = task.state.replace("-", " ");
    const owned = (await this.orchestration.list()).filter(
      (resource) => resource.ownerTaskId === task.id,
    );
    const active = owned.filter(
      (resource) =>
        resource.status === "starting" || resource.status === "running",
    );
    const failures = owned.filter(
      (resource) =>
        resource.status === "failed" || resource.status === "timed-out",
    );
    const settled = owned.filter(
      (resource) =>
        resource.status !== "starting" && resource.status !== "running",
    );
    await this.herdr
      .reportWorkspaceMetadata(task.workspaceId, "pi-first-mate", {
        repo: task.repoBasename ?? basename(resolve(task.cwd)),
        task_status: status,
        mate_state: status,
        active_leaves: String(
          active.filter((resource) => resource.kind === "subagent").length,
        ),
        active_jobs: String(
          active.filter((resource) => resource.kind !== "subagent").length,
        ),
        task_progress: `${settled.length}/${owned.length}`,
        decision_state: task.state === "waiting-decision" ? "waiting" : "clear",
        failure_state: String(failures.length + (task.error ? 1 : 0)),
        retention: task.pinned ? "pinned" : "automatic",
        worker_summary: `${active.length} active`,
      })
      .catch(() => undefined);
  }

  private async requireTask(taskId: string) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Unknown fleet task ${taskId}.`);
    return task;
  }

  private async requireOwnedTask(taskId: string, sessionId: string) {
    const task = await this.requireTask(taskId);
    if (task.ownerSessionId !== sessionId)
      throw new Error(
        `Session ${sessionId} does not own fleet task ${taskId}.`,
      );
    return task;
  }

  private async requireMateTask(taskId: string, sessionId: string) {
    const task = await this.requireTask(taskId);
    if (task.mateSessionId !== sessionId)
      throw new Error(`Session ${sessionId} is not the mate for ${taskId}.`);
    return task;
  }
}
