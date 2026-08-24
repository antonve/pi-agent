import type { FleetMessage, FleetTask } from "./fleet.ts";
import type {
  ManualTodoItem,
  PullRequestSnapshot,
  TodoBoardState,
  TodoResolution,
} from "./first-mate-todo-state.ts";

const GITHUB_PULL_URL =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\b|\/)/g;

export type TodoItemKind =
  | "review"
  | "decision"
  | "risk"
  | "blocker"
  | "failure"
  | "outcome"
  | "manual";

export interface TodoItem {
  id: string;
  kind: TodoItemKind;
  title: string;
  detail?: string;
  source: "generated" | "manual";
  taskId?: string;
  taskTitle?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  prUrl?: string;
  prSnapshot?: PullRequestSnapshot;
  createdAt: number;
  updatedAt: number;
}

export interface TodoBoardView {
  items: TodoItem[];
  generatedCount: number;
  manualCount: number;
  snoozedCount: number;
  hiddenCount: number;
  trackedPrUrls: string[];
}

function cleanText(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim() || undefined
    : undefined;
}

function latestMessage(
  messages: readonly FleetMessage[],
  ...types: FleetMessage["type"][]
) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (types.includes(message.type)) return message;
  }
  return undefined;
}

function detailFromPayload(payload: Record<string, unknown>) {
  return [
    cleanText(payload.summary),
    cleanText(payload.question),
    cleanText(payload.message),
    cleanText(payload.error),
    cleanText(payload.impact),
    Array.isArray(payload.artifacts)
      ? cleanText((payload.artifacts as unknown[]).join(" · "))
      : undefined,
  ].find((value) => value !== undefined);
}

function hiddenByResolution(
  resolution: TodoResolution | undefined,
  now: number,
) {
  if (!resolution) return { hidden: false, snoozed: false };
  if (resolution.state === "snoozed")
    return {
      hidden: resolution.until !== undefined && resolution.until > now,
      snoozed: resolution.until !== undefined && resolution.until > now,
    };
  return { hidden: true, snoozed: false };
}

function manualItem(item: ManualTodoItem): TodoItem {
  return {
    id: item.id,
    kind: "manual",
    title: item.title,
    source: "manual",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function pushGeneratedItem(
  items: TodoItem[],
  resolutions: Record<string, TodoResolution>,
  hiddenCounts: { hidden: number; snoozed: number },
  now: number,
  item: TodoItem,
) {
  const hidden = hiddenByResolution(resolutions[item.id], now);
  if (hidden.hidden) {
    hiddenCounts.hidden++;
    if (hidden.snoozed) hiddenCounts.snoozed++;
    return;
  }
  items.push(item);
}

function baseTaskItem(task: FleetTask, item: TodoItem) {
  return {
    ...item,
    taskId: task.id,
    taskTitle: task.title,
    workspaceId: task.workspaceId,
    tabId: task.mateTabId,
    paneId: task.matePaneId,
  };
}

function reviewItems(
  task: FleetTask,
  completion: FleetMessage | undefined,
  pullRequests: Record<string, PullRequestSnapshot>,
  resolutions: Record<string, TodoResolution>,
) {
  const items: TodoItem[] = [];
  const trackedPrUrls: string[] = [];
  if (!completion) return { items, trackedPrUrls };
  const urls = extractGitHubPullRequestUrls(completion.payload);
  for (const url of urls) {
    const id = `review:${task.id}:${completion.id}:${url}`;
    const snapshot = pullRequests[url];
    const resolution = resolutions[id];
    if (
      (!snapshot || snapshot.state === "open") &&
      resolution?.state !== "done" &&
      resolution?.state !== "dismissed"
    )
      trackedPrUrls.push(url);
    if (snapshot && (snapshot.state !== "open" || snapshot.draft)) continue;
    const detail = [snapshot?.title, snapshot?.reviewDecision, snapshot?.state]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(" · ");
    items.push(
      baseTaskItem(task, {
        id,
        kind: "review",
        title: `Review PR for ${task.id}`,
        detail: detail || url,
        source: "generated",
        prUrl: url,
        prSnapshot: snapshot,
        createdAt: completion.createdAt,
        updatedAt: completion.createdAt,
      }),
    );
  }
  return { items, trackedPrUrls };
}

function generatedItemsForTask(
  task: FleetTask,
  messages: readonly FleetMessage[],
  pullRequests: Record<string, PullRequestSnapshot>,
  resolutions: Record<string, TodoResolution>,
) {
  const items: TodoItem[] = [];
  const trackedPrUrls: string[] = [];
  const risk = latestMessage(messages, "MATERIAL_RISK");
  if (risk && task.state === "active") {
    items.push(
      baseTaskItem(task, {
        id: `risk:${task.id}:${risk.id}`,
        kind: "risk",
        title: `Review risk for ${task.id}`,
        detail: detailFromPayload(risk.payload),
        source: "generated",
        createdAt: risk.createdAt,
        updatedAt: risk.createdAt,
      }),
    );
  }
  if (task.state === "waiting-decision") {
    const decision = latestMessage(messages, "DECISION_REQUEST");
    items.push(
      baseTaskItem(task, {
        id: `decision:${task.id}:${decision?.id ?? task.version}`,
        kind: "decision",
        title: `Answer decision for ${task.id}`,
        detail: decision ? detailFromPayload(decision.payload) : task.title,
        source: "generated",
        createdAt: decision?.createdAt ?? task.updatedAt,
        updatedAt: decision?.createdAt ?? task.updatedAt,
      }),
    );
  }
  if (task.state === "blocked") {
    const blocked = latestMessage(messages, "TASK_BLOCKED");
    items.push(
      baseTaskItem(task, {
        id: `blocker:${task.id}:${blocked?.id ?? task.version}`,
        kind: "blocker",
        title: `Unblock ${task.id}`,
        detail: blocked ? detailFromPayload(blocked.payload) : task.title,
        source: "generated",
        createdAt: blocked?.createdAt ?? task.updatedAt,
        updatedAt: blocked?.createdAt ?? task.updatedAt,
      }),
    );
  }
  if (task.state === "failed") {
    const failed = latestMessage(messages, "TASK_FAILED");
    items.push(
      baseTaskItem(task, {
        id: `failure:${task.id}:${failed?.id ?? task.version}`,
        kind: "failure",
        title: `Inspect failure for ${task.id}`,
        detail:
          (failed ? detailFromPayload(failed.payload) : undefined) ??
          task.error,
        source: "generated",
        createdAt: failed?.createdAt ?? task.updatedAt,
        updatedAt: failed?.createdAt ?? task.updatedAt,
      }),
    );
  }
  if (task.state === "completed") {
    const completed = latestMessage(messages, "TASK_COMPLETED");
    items.push(
      baseTaskItem(task, {
        id: `outcome:${task.id}:${completed?.id ?? task.version}`,
        kind: "outcome",
        title: `Review outcome for ${task.id}`,
        detail: completed ? detailFromPayload(completed.payload) : task.title,
        source: "generated",
        createdAt: completed?.createdAt ?? task.updatedAt,
        updatedAt: completed?.createdAt ?? task.updatedAt,
      }),
    );
    const reviews = reviewItems(task, completed, pullRequests, resolutions);
    items.push(...reviews.items);
    trackedPrUrls.push(...reviews.trackedPrUrls);
  }
  return { items, trackedPrUrls };
}

function priority(item: TodoItem) {
  switch (item.kind) {
    case "review":
      return 0;
    case "decision":
      return 1;
    case "risk":
      return 2;
    case "blocker":
      return 3;
    case "failure":
      return 4;
    case "outcome":
      return 5;
    case "manual":
      return 6;
  }
}

export function extractGitHubPullRequestUrls(value: unknown) {
  const found = new Set<string>();
  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(GITHUB_PULL_URL))
        found.add(match[0]);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate && typeof candidate === "object")
      Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...found];
}

export function buildTodoBoardView(options: {
  boardState: TodoBoardState;
  tasks: readonly FleetTask[];
  messagesByTask: ReadonlyMap<string, readonly FleetMessage[]>;
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const hiddenCounts = { hidden: 0, snoozed: 0 };
  const generated: TodoItem[] = [];
  const manual: TodoItem[] = [];
  const trackedPrUrls = new Set<string>();

  for (const task of options.tasks) {
    const taskItems = generatedItemsForTask(
      task,
      options.messagesByTask.get(task.id) ?? [],
      options.boardState.pullRequests,
      options.boardState.resolutions,
    );
    taskItems.trackedPrUrls.forEach((url) => trackedPrUrls.add(url));
    for (const item of taskItems.items)
      pushGeneratedItem(
        generated,
        options.boardState.resolutions,
        hiddenCounts,
        now,
        item,
      );
  }

  for (const item of options.boardState.manualItems.map((candidate) =>
    manualItem(candidate),
  ))
    pushGeneratedItem(
      manual,
      options.boardState.resolutions,
      hiddenCounts,
      now,
      item,
    );

  generated.sort((left, right) => {
    const order = priority(left) - priority(right);
    if (order !== 0) return order;
    return right.updatedAt - left.updatedAt;
  });
  manual.sort((left, right) => right.updatedAt - left.updatedAt);

  const items = [...generated, ...manual];
  return {
    items,
    generatedCount: generated.length,
    manualCount: manual.length,
    snoozedCount: hiddenCounts.snoozed,
    hiddenCount: hiddenCounts.hidden,
    trackedPrUrls: [...trackedPrUrls],
  } satisfies TodoBoardView;
}

export function parseSnoozeDuration(value: string, now = Date.now()) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(\d+)(m|h|d)$/);
  if (!match) return undefined;
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const multiplier =
    match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return now + amount * multiplier;
}
