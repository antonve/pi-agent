export const PLACEMENTS = ["auto", "tab", "pane"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export type ResolvedPlacement = Exclude<Placement, "auto">;

export const ISOLATIONS = ["auto", "treehouse", "shared"] as const;
export type Isolation = (typeof ISOLATIONS)[number];

export const HARNESSES = ["pi", "claude", "codex", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type TaskKind = "background" | "subagent" | "workflow-child";
export type ExecutionMode = "interactive" | "headless";
export const AUTO_CLOSE_MS = 30_000;
export const UNKNOWN_AGENT_GRACE_MS = 5 * 60_000;
export const CLOSED_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type TaskStatus =
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "timed-out";

export function isAutoCloseStatus(status: TaskStatus) {
  return (
    status === "done" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "timed-out"
  );
}

export interface LeaseRecord {
  leaseId: string;
  holder: string;
  path: string;
  repositoryRoot: string;
  returnState: "held" | "shared" | "returned" | "dirty" | "error";
  returnError?: string;
}

export interface TaskRecord {
  id: string;
  label: string;
  kind: TaskKind;
  parentSession?: string;
  parentWorkspaceId: string;
  parentTabId: string;
  parentPaneId: string;
  tabId?: string;
  paneId: string;
  createdTab: boolean;
  createdPane: boolean;
  agentName?: string;
  promptStateChangeSeq?: number;
  executionMode?: ExecutionMode;
  harnessSessionId?: string;
  runDirectory?: string;
  promptPath?: string;
  outputPath?: string;
  exitStatusPath?: string;
  lastMessagePath?: string;
  turn?: number;
  pinned?: boolean;
  ownerTaskId?: string;
  jobKind?: "finite" | "service";
  deadlineAt?: number;
  readinessPattern?: string;
  readinessDeadlineAt?: number;
  readinessAt?: number;
  stopPolicy?: "parent" | "task";
  harness?: Harness;
  model?: string;
  reasoning?: ReasoningLevel;
  cwd: string;
  placement: ResolvedPlacement;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
  autoCloseAt?: number;
  autoCloseCancelled?: boolean;
  resourceClosedAt?: number;
  lease?: LeaseRecord;
  completionResultPath?: string;
  completionReport?: string;
  exitCode?: number;
  error?: string;
  sentinel?: string;
  snapshotMarker?: string;
}

export function needsInspection(task: TaskRecord, now = Date.now()) {
  if (task.status === "blocked") return true;
  if (task.status !== "failed" && task.status !== "interrupted") return false;
  return (
    task.resourceClosedAt === undefined &&
    (task.autoCloseCancelled === true ||
      task.autoCloseAt === undefined ||
      task.autoCloseAt > now)
  );
}

export interface ParentLocation {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface CreatedResource {
  placement: ResolvedPlacement;
  workspaceId: string;
  tabId: string;
  paneId: string;
  createdTab: boolean;
  createdPane: boolean;
}

export interface CreatedTaskWorkspace {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface SpawnAgentOptions {
  prompt: string;
  label: string;
  harness: Harness;
  cwd: string;
  model?: string;
  reasoning?: ReasoningLevel;
  isolation: Isolation;
  placement: Placement;
  parentSession?: string;
  ownerTaskId?: string;
  parentModel?: string;
  parentReasoning?: ReasoningLevel;
  kind?: "subagent" | "workflow-child";
}
