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
export type TaskStatus =
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted";

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
  lease?: LeaseRecord;
  completionResultPath?: string;
  exitCode?: number;
  error?: string;
  sentinel?: string;
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
  parentModel?: string;
  parentReasoning?: ReasoningLevel;
  kind?: "subagent" | "workflow-child";
}
