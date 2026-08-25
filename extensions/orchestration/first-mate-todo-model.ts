import type { FleetMessage, FleetTask } from "./fleet.ts";
import type {
  ManualTodoItem,
  PullRequestSnapshot,
  TodoBoardState,
  TodoHistoryItem,
  TodoHistoryItemKind,
  TodoHistoryStatus,
  TodoResolution,
} from "./first-mate-todo-state.ts";

const GITHUB_PULL_URL =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\b|\/)/g;
const ESCALATION_ACKNOWLEDGEMENT_TYPES = new Set<FleetMessage["type"]>([
  "DECISION_RESPONSE",
  "SCOPE_UPDATE",
  "PRIORITY_UPDATE",
]);

export type TodoItemKind = TodoHistoryItemKind;

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
  historyStatus?: TodoHistoryStatus;
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
  generatedItemIds?: string[];
  generatedCandidates?: TodoItem[];
  automaticHistoryItems?: TodoHistoryItem[];
  historyItems?: TodoItem[];
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

function latestMessageBySequence(
  taskId: string,
  messages: readonly FleetMessage[],
  type: FleetMessage["type"],
) {
  return messages.reduce<FleetMessage | undefined>(
    (latest, message) =>
      message.taskId === taskId &&
      message.type === type &&
      (!latest || message.sequence > latest.sequence)
        ? message
        : latest,
    undefined,
  );
}

function laterControlAcknowledgement(
  taskId: string,
  messages: readonly FleetMessage[],
  event: FleetMessage | undefined,
) {
  if (!event) return undefined;
  return messages.reduce<FleetMessage | undefined>(
    (earliest, message) =>
      message.taskId === taskId &&
      message.toTaskMate === true &&
      ESCALATION_ACKNOWLEDGEMENT_TYPES.has(message.type) &&
      message.sequence > event.sequence &&
      (!earliest || message.sequence < earliest.sequence)
        ? message
        : earliest,
    undefined,
  );
}

function laterMessageBySequence(
  taskId: string,
  messages: readonly FleetMessage[],
  event: FleetMessage,
  types: readonly FleetMessage["type"][],
) {
  return messages.reduce<FleetMessage | undefined>(
    (earliest, message) =>
      message.taskId === taskId &&
      types.includes(message.type) &&
      message.sequence > event.sequence &&
      (!earliest || message.sequence < earliest.sequence)
        ? message
        : earliest,
    undefined,
  );
}

function historyItem(
  item: TodoItem,
  status: TodoHistoryStatus,
  resolvedAt: number,
): TodoHistoryItem {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    title: item.title,
    taskId: item.taskId,
    taskTitle: item.taskTitle,
    detail: item.detail,
    status,
    prUrl: item.prUrl,
    resolvedAt,
  };
}

function todoItemFromHistory(item: TodoHistoryItem): TodoItem {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    title: item.title,
    taskId: item.taskId,
    taskTitle: item.taskTitle,
    detail: [item.status, item.detail].filter(Boolean).join(" · "),
    historyStatus: item.status,
    prUrl: item.prUrl,
    createdAt: item.resolvedAt,
    updatedAt: item.resolvedAt,
  };
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

function baseTaskItem(task: FleetTask, item: TodoItem, focusable: boolean) {
  return {
    ...item,
    taskId: task.id,
    taskTitle: task.title,
    ...(focusable && task.workspaceClosedAt === undefined
      ? {
          workspaceId: task.workspaceId,
          tabId: task.mateTabId,
          paneId: task.matePaneId,
        }
      : {}),
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
  const generatedCandidates: TodoItem[] = [];
  const automaticHistoryItems: TodoHistoryItem[] = [];
  if (!completion)
    return {
      items,
      trackedPrUrls,
      generatedCandidates,
      automaticHistoryItems,
    };
  const urls = extractGitHubPullRequestUrls(completion.payload);
  for (const url of urls) {
    const id = `review:${task.id}:${completion.id}:${url}`;
    const snapshot = pullRequests[url];
    const resolution = resolutions[id];
    const detail = [snapshot?.title, snapshot?.reviewDecision, snapshot?.state]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(" · ");
    const candidate = baseTaskItem(
      task,
      {
        id,
        kind: "review",
        title: `Review PR for ${task.id}`,
        detail: detail || url,
        source: "generated",
        prUrl: url,
        prSnapshot: snapshot,
        createdAt: completion.createdAt,
        updatedAt: completion.createdAt,
      },
      false,
    );
    if (!snapshot || snapshot.state === "open")
      generatedCandidates.push(candidate);
    else
      automaticHistoryItems.push(
        historyItem(candidate, snapshot.state, snapshot.fetchedAt),
      );
    if (
      (!snapshot || snapshot.state === "open") &&
      resolution?.state !== "done" &&
      resolution?.state !== "dismissed"
    )
      trackedPrUrls.push(url);
    if (snapshot?.state === "open" && !snapshot.draft) items.push(candidate);
  }
  return {
    items,
    trackedPrUrls,
    generatedCandidates,
    automaticHistoryItems,
  };
}

function generatedItemsForTask(
  task: FleetTask,
  messages: readonly FleetMessage[],
  pullRequests: Record<string, PullRequestSnapshot>,
  resolutions: Record<string, TodoResolution>,
  focusable: boolean,
) {
  const items: TodoItem[] = [];
  const trackedPrUrls: string[] = [];
  const generatedCandidates: TodoItem[] = [];
  const automaticHistoryItems: TodoHistoryItem[] = [];
  const addActive = (item: TodoItem) => {
    generatedCandidates.push(item);
    items.push(item);
  };

  const risks = messages
    .filter(
      (message) =>
        message.taskId === task.id && message.type === "MATERIAL_RISK",
    )
    .sort((left, right) => left.sequence - right.sequence);
  const riskCandidate = (risk: FleetMessage) =>
    baseTaskItem(
      task,
      {
        id: `risk:${task.id}:${risk.id}`,
        kind: "risk",
        title: `Review risk for ${task.id}`,
        detail: detailFromPayload(risk.payload),
        source: "generated",
        createdAt: risk.createdAt,
        updatedAt: risk.createdAt,
      },
      focusable,
    );
  for (let index = 0; index < risks.length - 1; index++) {
    const risk = risks[index]!;
    const nextRisk = risks[index + 1]!;
    const acknowledgement = laterControlAcknowledgement(
      task.id,
      messages,
      risk,
    );
    automaticHistoryItems.push(
      historyItem(
        riskCandidate(risk),
        acknowledgement && acknowledgement.sequence < nextRisk.sequence
          ? "acknowledged"
          : "resolved",
        acknowledgement && acknowledgement.sequence < nextRisk.sequence
          ? acknowledgement.createdAt
          : nextRisk.createdAt,
      ),
    );
  }
  const risk = risks.at(-1);
  const riskAcknowledgement = laterControlAcknowledgement(
    task.id,
    messages,
    risk,
  );
  if (risk) {
    const candidate = riskCandidate(risk);
    // PAUSE and RESUME only change lifecycle state; they do not by themselves
    // communicate that the first mate considered or accepted an escalation.
    if (riskAcknowledgement)
      automaticHistoryItems.push(
        historyItem(candidate, "acknowledged", riskAcknowledgement.createdAt),
      );
    else if (
      task.state === "completed" ||
      task.state === "failed" ||
      task.state === "cancelled"
    )
      automaticHistoryItems.push(
        historyItem(
          candidate,
          "resolved",
          laterMessageBySequence(task.id, messages, risk, [
            "TASK_COMPLETED",
            "TASK_FAILED",
            "CANCEL",
          ])?.createdAt ?? risk.createdAt,
        ),
      );
    else {
      generatedCandidates.push(candidate);
      if (task.state === "active") items.push(candidate);
    }
  }

  const decision = latestMessageBySequence(
    task.id,
    messages,
    "DECISION_REQUEST",
  );
  if (decision || task.state === "waiting-decision") {
    const candidate = baseTaskItem(
      task,
      {
        id: `decision:${task.id}:${decision?.id ?? "task"}`,
        kind: "decision",
        title: `Answer decision for ${task.id}`,
        detail: decision ? detailFromPayload(decision.payload) : task.title,
        source: "generated",
        createdAt: decision?.createdAt ?? task.updatedAt,
        updatedAt: decision?.createdAt ?? task.updatedAt,
      },
      focusable,
    );
    if (task.state === "waiting-decision") addActive(candidate);
    else if (decision) {
      const acknowledgement = laterControlAcknowledgement(
        task.id,
        messages,
        decision,
      );
      automaticHistoryItems.push(
        historyItem(
          candidate,
          acknowledgement ? "acknowledged" : "resolved",
          acknowledgement?.createdAt ??
            laterMessageBySequence(task.id, messages, decision, [
              "MATERIAL_RISK",
              "TASK_BLOCKED",
              "TASK_COMPLETED",
              "TASK_FAILED",
              "CANCEL",
            ])?.createdAt ??
            decision.createdAt,
        ),
      );
    }
  }

  const blocked = latestMessageBySequence(task.id, messages, "TASK_BLOCKED");
  if (blocked || task.state === "blocked") {
    const candidate = baseTaskItem(
      task,
      {
        id: `blocker:${task.id}:${blocked?.id ?? "task"}`,
        kind: "blocker",
        title: `Unblock ${task.id}`,
        detail: blocked ? detailFromPayload(blocked.payload) : task.title,
        source: "generated",
        createdAt: blocked?.createdAt ?? task.updatedAt,
        updatedAt: blocked?.createdAt ?? task.updatedAt,
      },
      focusable,
    );
    if (task.state === "blocked") addActive(candidate);
    else if (blocked) {
      const acknowledgement = laterControlAcknowledgement(
        task.id,
        messages,
        blocked,
      );
      automaticHistoryItems.push(
        historyItem(
          candidate,
          acknowledgement ? "acknowledged" : "resolved",
          acknowledgement?.createdAt ??
            laterMessageBySequence(task.id, messages, blocked, [
              "MATERIAL_RISK",
              "TASK_COMPLETED",
              "TASK_FAILED",
              "CANCEL",
            ])?.createdAt ??
            blocked.createdAt,
        ),
      );
    }
  }

  const failed = latestMessageBySequence(task.id, messages, "TASK_FAILED");
  if (failed || task.state === "failed") {
    const candidate = baseTaskItem(
      task,
      {
        id: `failure:${task.id}:${failed?.id ?? "task"}`,
        kind: "failure",
        title: `Inspect failure for ${task.id}`,
        detail:
          (failed ? detailFromPayload(failed.payload) : undefined) ??
          task.error,
        source: "generated",
        createdAt: failed?.createdAt ?? task.updatedAt,
        updatedAt: failed?.createdAt ?? task.updatedAt,
      },
      focusable,
    );
    const acknowledgement = laterControlAcknowledgement(
      task.id,
      messages,
      failed,
    );
    if (acknowledgement)
      automaticHistoryItems.push(
        historyItem(candidate, "acknowledged", acknowledgement.createdAt),
      );
    else if (task.state === "failed") addActive(candidate);
    else if (failed)
      automaticHistoryItems.push(
        historyItem(
          candidate,
          "resolved",
          laterMessageBySequence(task.id, messages, failed, [
            "TASK_COMPLETED",
            "CANCEL",
          ])?.createdAt ?? failed.createdAt,
        ),
      );
  }

  if (task.state === "completed") {
    const completed = latestMessage(messages, "TASK_COMPLETED");
    const outcome = baseTaskItem(
      task,
      {
        id: `outcome:${task.id}:${completed?.id ?? "task"}`,
        kind: "outcome",
        title: `Completed ${task.id}`,
        detail: completed ? detailFromPayload(completed.payload) : task.title,
        source: "generated",
        createdAt: completed?.createdAt ?? task.updatedAt,
        updatedAt: completed?.createdAt ?? task.updatedAt,
      },
      false,
    );
    automaticHistoryItems.push(
      historyItem(outcome, "completed", completed?.createdAt ?? task.updatedAt),
    );
    const reviews = reviewItems(task, completed, pullRequests, resolutions);
    items.push(...reviews.items);
    trackedPrUrls.push(...reviews.trackedPrUrls);
    generatedCandidates.push(...reviews.generatedCandidates);
    automaticHistoryItems.push(...reviews.automaticHistoryItems);
  }
  return {
    items,
    trackedPrUrls,
    generatedCandidates,
    automaticHistoryItems,
  };
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
  focusableTaskIds?: ReadonlySet<string>;
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const hiddenCounts = { hidden: 0, snoozed: 0 };
  const generated: TodoItem[] = [];
  const manual: TodoItem[] = [];
  const trackedPrUrls = new Set<string>();
  const generatedCandidates = new Map<string, TodoItem>();
  const automaticHistoryItems = new Map<string, TodoHistoryItem>();

  for (const task of options.tasks) {
    const taskItems = generatedItemsForTask(
      task,
      options.messagesByTask.get(task.id) ?? [],
      options.boardState.pullRequests,
      options.boardState.resolutions,
      options.focusableTaskIds?.has(task.id) === true,
    );
    taskItems.trackedPrUrls.forEach((url) => trackedPrUrls.add(url));
    taskItems.generatedCandidates.forEach((item) =>
      generatedCandidates.set(item.id, item),
    );
    taskItems.automaticHistoryItems.forEach((item) =>
      automaticHistoryItems.set(item.id, item),
    );
    for (const item of taskItems.items) {
      generatedCandidates.set(item.id, item);
      pushGeneratedItem(
        generated,
        options.boardState.resolutions,
        hiddenCounts,
        now,
        item,
      );
    }
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
  const historyItems = [...(options.boardState.historyItems ?? [])]
    .sort(
      (left, right) =>
        right.resolvedAt - left.resolvedAt || left.id.localeCompare(right.id),
    )
    .map(todoItemFromHistory);
  return {
    items,
    generatedCount: generated.length,
    manualCount: manual.length,
    snoozedCount: hiddenCounts.snoozed,
    hiddenCount: hiddenCounts.hidden,
    trackedPrUrls: [...trackedPrUrls],
    generatedItemIds: [...generatedCandidates.keys()],
    generatedCandidates: [...generatedCandidates.values()],
    automaticHistoryItems: [...automaticHistoryItems.values()],
    historyItems,
  } satisfies TodoBoardView;
}

const GENERATED_ITEM_PREFIXES = [
  "review:",
  "decision:",
  "risk:",
  "blocker:",
  "failure:",
  "outcome:",
] as const;
export const TODO_HISTORY_LIMIT = 500;

function fallbackHistoryItem(
  id: string,
  resolution: TodoResolution,
): TodoHistoryItem | undefined {
  const prefix = GENERATED_ITEM_PREFIXES.find((candidate) =>
    id.startsWith(candidate),
  );
  if (!prefix || resolution.state === "snoozed") return undefined;
  const kind = prefix.slice(0, -1) as TodoHistoryItemKind;
  const taskId = id.split(":")[1];
  return {
    id,
    source: "generated",
    kind,
    title: taskId ? `${kind} ${taskId}` : kind,
    taskId,
    status: resolution.state,
    resolvedAt: resolution.at,
  };
}

function cappedHistory(items: readonly TodoHistoryItem[]) {
  const deduplicated = new Map<string, TodoHistoryItem>();
  for (const item of items) {
    const previous = deduplicated.get(item.id);
    if (!previous || item.resolvedAt >= previous.resolvedAt)
      deduplicated.set(item.id, item);
  }
  return [...deduplicated.values()]
    .sort(
      (left, right) =>
        right.resolvedAt - left.resolvedAt || left.id.localeCompare(right.id),
    )
    .slice(0, TODO_HISTORY_LIMIT);
}

export function reconcileTodoBoardState(
  state: TodoBoardState,
  derived: Pick<TodoBoardView, "generatedCandidates" | "automaticHistoryItems">,
) {
  const generatedCandidates = new Map(
    (derived.generatedCandidates ?? []).map((item) => [item.id, item]),
  );
  const automaticHistoryItems = derived.automaticHistoryItems ?? [];
  const automaticHistoryIds = new Set(
    automaticHistoryItems.map((item) => item.id),
  );
  const existingHistoryIds = new Set(
    (state.historyItems ?? []).map((item) => item.id),
  );
  const historyItems: TodoHistoryItem[] = [
    ...(state.historyItems ?? []),
    ...automaticHistoryItems,
  ];
  const archivedManualIds = new Set<string>();
  const archivedResolutionIds = new Set<string>();

  for (const item of state.manualItems) {
    const resolution = state.resolutions[item.id];
    if (
      !resolution ||
      (resolution.state !== "done" && resolution.state !== "dismissed")
    )
      continue;
    // Dismissal remains traceable in History rather than acting as permanent
    // erasure; this preserves the audit trail while keeping Active empty.
    historyItems.push(
      historyItem(manualItem(item), resolution.state, resolution.at),
    );
    archivedManualIds.add(item.id);
    archivedResolutionIds.add(item.id);
  }

  for (const [id, resolution] of Object.entries(state.resolutions)) {
    if (archivedResolutionIds.has(id)) continue;
    const candidate = generatedCandidates.get(id);
    if (
      candidate &&
      (resolution.state === "done" || resolution.state === "dismissed")
    ) {
      historyItems.push(
        historyItem(candidate, resolution.state, resolution.at),
      );
      // Keep the generated-item resolution as the durable Active suppression
      // marker. History records trace it; removing it would resurrect the item.
      continue;
    }
    const generated = GENERATED_ITEM_PREFIXES.some((prefix) =>
      id.startsWith(prefix),
    );
    if (!generated) continue;
    if (automaticHistoryIds.has(id) || !candidate) {
      const fallback = fallbackHistoryItem(id, resolution);
      if (fallback && !existingHistoryIds.has(id)) historyItems.push(fallback);
      archivedResolutionIds.add(id);
    }
  }

  const next: TodoBoardState = {
    ...state,
    manualItems: state.manualItems.filter(
      (item) => !archivedManualIds.has(item.id),
    ),
    resolutions: Object.fromEntries(
      Object.entries(state.resolutions).filter(
        ([id]) => !archivedResolutionIds.has(id),
      ),
    ),
    historyItems: cappedHistory(historyItems),
  };
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
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
