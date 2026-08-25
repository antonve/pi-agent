import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { FleetStore, type FleetMessage, type FleetTask } from "./fleet.ts";
import {
  buildTodoBoardView,
  parseSnoozeDuration,
  reconcileTodoBoardState,
  TODO_HISTORY_LIMIT,
  type TodoBoardView,
} from "./first-mate-todo-model.ts";
import {
  renderTodoPane,
  handleTodoKey,
  normalizeUiState,
  sanitizeTodoText,
  type TodoUiState,
} from "./first-mate-todo-view.ts";
import {
  TodoBoardStateStore,
  type TodoBoardState,
} from "./first-mate-todo-state.ts";

function task(state: FleetTask["state"], id: string): FleetTask {
  return {
    id,
    title: `${id} title`,
    brief: `${id} brief`,
    cwd: "/repo",
    state,
    ownerSessionId: "first-mate",
    workspaceId: `w-${id}`,
    mateTabId: `w-${id}:t1`,
    matePaneId: `w-${id}:p1`,
    createdAt: 1,
    updatedAt: 100,
    version: 3,
    nextSequence: 4,
  };
}

function message(
  taskId: string,
  type: FleetMessage["type"],
  sequence: number,
  payload: Record<string, unknown>,
): FleetMessage {
  return {
    id: `${taskId}-${type}-${sequence}`,
    taskId,
    type,
    fromSessionId: "mate",
    toSessionId: "first-mate",
    sequence,
    createdAt: 10 * sequence,
    payload,
    requiresAck: true,
  };
}

function controlMessage(
  taskId: string,
  type: FleetMessage["type"],
  sequence: number,
  payload: Record<string, unknown> = {},
): FleetMessage {
  return {
    ...message(taskId, type, sequence, payload),
    fromSessionId: "first-mate",
    toSessionId: "mate",
    toTaskMate: true,
  };
}

test("board derivation combines generated and manual items with persisted resolution", () => {
  const now = 1_000_000;
  const prUrl = "https://github.com/antonve/pi-agent/pull/99";
  const boardState: TodoBoardState = {
    version: 1,
    manualItems: [
      {
        id: "manual:1",
        title: "Remember to update docs",
        createdAt: now - 100,
        updatedAt: now - 50,
      },
    ],
    resolutions: {
      "manual:1": { state: "snoozed", at: now - 10, until: now + 60_000 },
    },
    pullRequests: {
      [prUrl]: {
        url: prUrl,
        title: "Add the todo pane",
        state: "open",
        draft: false,
        reviewDecision: "review_required",
        fetchedAt: now - 1_000,
      },
    },
  };
  const reviewTask = task("completed", "TASK-1");
  const decisionTask = task("waiting-decision", "TASK-2");
  const view = buildTodoBoardView({
    boardState,
    tasks: [reviewTask, decisionTask],
    messagesByTask: new Map([
      [
        reviewTask.id,
        [
          message(reviewTask.id, "TASK_COMPLETED", 1, {
            summary: "PR is ready",
            artifacts: [prUrl],
          }),
        ],
      ],
      [
        decisionTask.id,
        [
          message(decisionTask.id, "DECISION_REQUEST", 1, {
            summary: "Choose rollout order",
            question: "Land PR #27 first?",
          }),
        ],
      ],
    ]),
    now,
  });

  assert.deepEqual(
    view.items.map((item) => [item.kind, item.taskId]),
    [
      ["review", "TASK-1"],
      ["decision", "TASK-2"],
    ],
  );
  assert.equal(view.manualCount, 0);
  assert.equal(view.snoozedCount, 1);
  assert.deepEqual(view.trackedPrUrls, [prUrl]);
  assert.match(view.items[0]?.detail ?? "", /review_required/);
});

test("draft and snoozed PRs stay tracked until permanently resolved", () => {
  const now = 1_000_000;
  const prUrl = "https://github.com/antonve/pi-agent/pull/99";
  const completed = task("completed", "TASK-1");
  const completion = message(completed.id, "TASK_COMPLETED", 1, {
    artifacts: [prUrl],
  });
  const reviewId = `review:${completed.id}:${completion.id}:${prUrl}`;
  const base: TodoBoardState = {
    version: 1,
    manualItems: [],
    resolutions: {
      [reviewId]: { state: "snoozed", at: now - 1, until: now + 60_000 },
    },
    pullRequests: {
      [prUrl]: {
        url: prUrl,
        state: "open",
        draft: true,
        fetchedAt: now - 1,
      },
    },
  };
  const options = {
    tasks: [completed],
    messagesByTask: new Map([[completed.id, [completion]]]),
    now,
  };

  const snoozed = buildTodoBoardView({ boardState: base, ...options });
  assert.equal(
    snoozed.items.some((item) => item.kind === "review"),
    false,
  );
  assert.deepEqual(snoozed.trackedPrUrls, [prUrl]);

  const done = buildTodoBoardView({
    boardState: {
      ...base,
      resolutions: { [reviewId]: { state: "done", at: now } },
    },
    ...options,
  });
  assert.deepEqual(done.trackedPrUrls, []);
});

test("resolved task risks reconcile away automatically", () => {
  const completed = task("completed", "TASK-1");
  const view = buildTodoBoardView({
    boardState: {
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
    },
    tasks: [completed],
    messagesByTask: new Map([
      [
        completed.id,
        [
          message(completed.id, "MATERIAL_RISK", 1, { summary: "Old risk" }),
          message(completed.id, "TASK_COMPLETED", 2, { summary: "Done" }),
        ],
      ],
    ]),
  });
  assert.equal(
    view.items.some((item) => item.kind === "risk"),
    false,
  );
});

test("later first-mate responses acknowledge risks by durable task sequence", () => {
  const responseTypes = [
    "DECISION_RESPONSE",
    "SCOPE_UPDATE",
    "PRIORITY_UPDATE",
  ] as const;
  const tasks = responseTypes.map((_, index) =>
    task("active", `TASK-${index + 1}`),
  );
  const messagesByTask = new Map(
    tasks.map((candidate, index) => {
      const risk = {
        ...message(candidate.id, "MATERIAL_RISK", 4, {
          summary: "Risk to acknowledge",
        }),
        createdAt: 10_000,
      };
      const response = {
        ...controlMessage(candidate.id, responseTypes[index]!, 5),
        createdAt: 1,
      };
      return [candidate.id, [response, risk]] as const;
    }),
  );

  const view = buildTodoBoardView({
    boardState: {
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
    },
    tasks,
    messagesByTask,
  });

  assert.equal(
    view.items.some((item) => item.kind === "risk"),
    false,
  );
});

test("older, task-originated, pause, resume, and other-task messages do not acknowledge a risk", () => {
  const active = task("active", "TASK-1");
  const view = buildTodoBoardView({
    boardState: {
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
    },
    tasks: [active],
    messagesByTask: new Map([
      [
        active.id,
        [
          controlMessage(active.id, "SCOPE_UPDATE", 1),
          message(active.id, "MATERIAL_RISK", 2, { summary: "Still open" }),
          message(active.id, "DECISION_RESPONSE", 3, {}),
          controlMessage(active.id, "PAUSE", 4),
          controlMessage(active.id, "RESUME", 5),
          controlMessage("TASK-2", "PRIORITY_UPDATE", 6),
        ],
      ],
    ]),
  });

  assert.equal(
    view.items.find((item) => item.kind === "risk")?.detail,
    "Still open",
  );
});

test("risk dismissal survives pause, inactivity, and resume without control acknowledgement", () => {
  const active = task("active", "TASK-1");
  const risk = message(active.id, "MATERIAL_RISK", 1, {
    summary: "Dismissed risk",
  });
  const riskId = `risk:${active.id}:${risk.id}`;
  const messages = [
    risk,
    controlMessage(active.id, "PAUSE", 2),
    controlMessage(active.id, "RESUME", 3),
  ];
  const legacyState: TodoBoardState = {
    version: 1,
    manualItems: [],
    resolutions: { [riskId]: { state: "dismissed", at: 20 } },
    pullRequests: {},
    historyItems: [],
  };
  const paused = { ...active, state: "paused" as const };
  const pausedView = buildTodoBoardView({
    boardState: legacyState,
    tasks: [paused],
    messagesByTask: new Map([[paused.id, messages]]),
  });
  const migrated = reconcileTodoBoardState(legacyState, pausedView);
  const inactiveView = buildTodoBoardView({
    boardState: migrated,
    tasks: [],
    messagesByTask: new Map(),
  });
  const inactive = reconcileTodoBoardState(migrated, inactiveView);
  const resumedView = buildTodoBoardView({
    boardState: inactive,
    tasks: [active],
    messagesByTask: new Map([[active.id, messages]]),
  });

  assert.deepEqual(migrated.dismissedRiskIds, [riskId]);
  assert.deepEqual(inactive.resolutions, {});
  assert.deepEqual(inactive.dismissedRiskIds, [riskId]);
  assert.equal(
    resumedView.items.some((item) => item.kind === "risk"),
    false,
  );
  assert.equal(
    resumedView.automaticHistoryItems?.some((item) => item.id === riskId),
    false,
  );
});

test("a dismissed risk does not hide a newer risk or another task's risk", () => {
  const first = task("active", "TASK-1");
  const second = task("active", "TASK-2");
  const dismissed = message(first.id, "MATERIAL_RISK", 1, {
    summary: "Dismissed risk",
  });
  const newer = message(first.id, "MATERIAL_RISK", 4, {
    summary: "New risk",
  });
  const other = message(second.id, "MATERIAL_RISK", 1, {
    summary: "Other task risk",
  });
  const dismissedId = `risk:${first.id}:${dismissed.id}`;
  const view = buildTodoBoardView({
    boardState: {
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
      dismissedRiskIds: [dismissedId],
    },
    tasks: [first, second],
    messagesByTask: new Map([
      [
        first.id,
        [
          dismissed,
          controlMessage(first.id, "PAUSE", 2),
          controlMessage(first.id, "RESUME", 3),
          newer,
        ],
      ],
      [second.id, [other]],
    ]),
  });

  assert.deepEqual(
    view.items
      .filter((item) => item.kind === "risk")
      .map((item) => [item.taskId, item.detail]),
    [
      [first.id, "New risk"],
      [second.id, "Other task risk"],
    ],
  );
  assert.equal(
    view.items.some((item) => item.id === dismissedId),
    false,
  );
});

test("legacy risk dismissal survives inactive reconciliation and process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-todo-risk-restart-"));
  const fleetPath = join(directory, "fleet.json");
  const boardPath = join(directory, "board.json");
  const fleet = new FleetStore(fleetPath);
  await fleet.createTask({
    id: "TASK-1",
    title: "Persisted task",
    brief: "Persisted task brief",
    cwd: "/repo",
    state: "active",
    ownerSessionId: "first-mate",
    mateSessionId: "mate",
  });
  const risk = await fleet.enqueue({
    taskId: "TASK-1",
    type: "MATERIAL_RISK",
    fromSessionId: "mate",
    toSessionId: "first-mate",
    payload: { summary: "Dismissed before restart" },
  });
  const riskId = `risk:TASK-1:${risk.id}`;
  await writeFile(
    boardPath,
    JSON.stringify({
      version: 1,
      manualItems: [],
      resolutions: {
        [riskId]: { state: "dismissed", at: 20 },
      },
      pullRequests: {},
    }),
  );

  const legacyBoard = new TodoBoardStateStore(boardPath);
  const migrated = await legacyBoard.read();
  assert.deepEqual(migrated.dismissedRiskIds, [riskId]);
  const inactive = reconcileTodoBoardState(
    migrated,
    buildTodoBoardView({
      boardState: migrated,
      tasks: [],
      messagesByTask: new Map(),
    }),
  );
  await legacyBoard.write(inactive);
  assert.deepEqual(inactive.resolutions, {});

  const restartedFleet = new FleetStore(fleetPath);
  const restartedBoard = new TodoBoardStateStore(boardPath);
  const persistedTask = (await restartedFleet.listTasks())[0]!;
  const persistedState = await restartedBoard.read();
  const view = buildTodoBoardView({
    boardState: persistedState,
    tasks: [persistedTask],
    messagesByTask: new Map([
      [
        persistedTask.id,
        await restartedFleet.messagesForTask(persistedTask.id),
      ],
    ]),
  });

  assert.deepEqual(persistedState.dismissedRiskIds, [riskId]);
  assert.equal(
    view.items.some((item) => item.kind === "risk"),
    false,
  );
});

test("the queue omits terminal outcomes but keeps unresolved failures and open PR actions safe", () => {
  const prUrl = "https://github.com/antonve/pi-agent/pull/123";
  const cleaned = {
    ...task("completed", "TASK-CLEANED"),
    workspaceClosedAt: 500,
  };
  const failed = {
    ...task("failed", "TASK-FAILED"),
    workspaceId: undefined,
    mateTabId: undefined,
    matePaneId: undefined,
    error: "Initial prompt delivery failed",
  };
  const paneGone = task("completed", "TASK-PANE-GONE");
  const review = task("completed", "TASK-PR");
  const view = buildTodoBoardView({
    boardState: {
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {
        [prUrl]: {
          url: prUrl,
          title: "Ready for review",
          state: "open",
          draft: false,
          reviewDecision: "review_required",
          fetchedAt: 1,
        },
      },
    },
    tasks: [cleaned, failed, paneGone, review],
    messagesByTask: new Map([
      [
        cleaned.id,
        [message(cleaned.id, "TASK_COMPLETED", 1, { summary: "Done" })],
      ],
      [
        paneGone.id,
        [message(paneGone.id, "TASK_COMPLETED", 1, { summary: "Done" })],
      ],
      [
        review.id,
        [message(review.id, "TASK_COMPLETED", 1, { artifacts: [prUrl] })],
      ],
    ]),
    // Even stale positive metadata cannot restore a janitor-closed workspace.
    focusableTaskIds: new Set([cleaned.id]),
  });

  assert.deepEqual(
    view.items.map((item) => [item.kind, item.taskId]),
    [
      ["review", review.id],
      ["failure", failed.id],
    ],
  );
  assert.equal(
    view.items.some((item) => item.kind === "outcome"),
    false,
  );
  const failure = view.items.find((item) => item.kind === "failure")!;
  assert.equal(failure.detail, "Initial prompt delivery failed");
  assert.equal(failure.paneId, undefined);
  assert.deepEqual(
    handleTodoKey(view, { showHelp: false, selectedId: failure.id }, "\r")
      .command,
    { type: "none" },
  );
  assert.deepEqual(
    handleTodoKey(view, { showHelp: false, selectedId: failure.id }, "x")
      .command,
    { type: "dismiss", itemId: failure.id },
  );
  const reviewItem = view.items.find((item) => item.kind === "review")!;
  assert.deepEqual(
    handleTodoKey(view, { showHelp: false, selectedId: reviewItem.id }, "\r")
      .command,
    { type: "open", item: reviewItem },
  );
});

test("unknown PR state is tracked for refresh without advertising an action", () => {
  const prUrl = "https://github.com/antonve/pi-agent/pull/124";
  const completed = task("completed", "TASK-PR");
  const view = buildTodoBoardView({
    boardState: {
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
    },
    tasks: [completed],
    messagesByTask: new Map([
      [
        completed.id,
        [message(completed.id, "TASK_COMPLETED", 1, { artifacts: [prUrl] })],
      ],
    ]),
  });

  assert.deepEqual(view.items, []);
  assert.deepEqual(view.trackedPrUrls, [prUrl]);
});

test("task focus is advertised only for a currently resolvable pane", () => {
  const active = task("active", "TASK-1");
  const risk = message(active.id, "MATERIAL_RISK", 1, {
    summary: "Needs attention",
  });
  const options = {
    boardState: {
      version: 1 as const,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
    },
    tasks: [active],
    messagesByTask: new Map([[active.id, [risk]]]),
  };
  const unavailable = buildTodoBoardView(options);
  const available = buildTodoBoardView({
    ...options,
    focusableTaskIds: new Set([active.id]),
  });
  const unavailableRisk = unavailable.items[0]!;
  const availableRisk = available.items[0]!;

  assert.equal(unavailableRisk.paneId, undefined);
  assert.deepEqual(
    handleTodoKey(
      unavailable,
      { showHelp: false, selectedId: unavailableRisk.id },
      "\r",
    ).command,
    { type: "none" },
  );
  assert.equal(availableRisk.paneId, active.matePaneId);
  assert.deepEqual(
    handleTodoKey(
      available,
      { showHelp: false, selectedId: availableRisk.id },
      "\r",
    ).command,
    { type: "focus", item: availableRisk },
  );
});

test("later first-mate control suppresses an acknowledged historical failure", () => {
  const failed = task("failed", "TASK-1");
  const view = buildTodoBoardView({
    boardState: {
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
    },
    tasks: [failed],
    messagesByTask: new Map([
      [
        failed.id,
        [
          message(failed.id, "TASK_FAILED", 1, { error: "Old failure" }),
          controlMessage(failed.id, "SCOPE_UPDATE", 2),
        ],
      ],
    ]),
  });

  assert.equal(
    view.items.some((item) => item.kind === "failure"),
    false,
  );
});

test("resolution reconciliation archives completed and dismissed items while preserving unresolved snoozes", () => {
  const state: TodoBoardState = {
    version: 1,
    manualItems: [
      { id: "manual:1", title: "Complete me", createdAt: 1, updatedAt: 1 },
      { id: "manual:2", title: "Dismiss me", createdAt: 1, updatedAt: 1 },
    ],
    resolutions: {
      "manual:1": { state: "done", at: 1 },
      "manual:2": { state: "dismissed", at: 6 },
      "outcome:TASK-1:old": { state: "dismissed", at: 2 },
      "risk:TASK-1:old": { state: "dismissed", at: 3 },
      "failure:TASK-2:task": { state: "snoozed", at: 4, until: 10 },
      "custom:future": { state: "done", at: 5 },
      "review:TASK-3:message:pr": { state: "done", at: 7 },
    },
    pullRequests: {},
    historyItems: [],
  };
  const failure = {
    id: "failure:TASK-2:task",
    kind: "failure" as const,
    title: "Inspect failure for TASK-2",
    source: "generated" as const,
    taskId: "TASK-2",
    createdAt: 1,
    updatedAt: 1,
  };
  const review = {
    id: "review:TASK-3:message:pr",
    kind: "review" as const,
    title: "Review PR for TASK-3",
    detail: "Ready",
    source: "generated" as const,
    taskId: "TASK-3",
    taskTitle: "TASK-3 title",
    prUrl: "https://github.com/antonve/pi-agent/pull/123",
    createdAt: 1,
    updatedAt: 1,
  };

  const reconciled = reconcileTodoBoardState(state, {
    generatedCandidates: [failure, review],
    automaticHistoryItems: [],
  });

  assert.deepEqual(reconciled.manualItems, []);
  assert.deepEqual(reconciled.resolutions, {
    "failure:TASK-2:task": { state: "snoozed", at: 4, until: 10 },
    "custom:future": { state: "done", at: 5 },
    "review:TASK-3:message:pr": { state: "done", at: 7 },
  });
  assert.deepEqual(
    reconciled.historyItems?.map((item) => [item.id, item.status]),
    [
      ["review:TASK-3:message:pr", "done"],
      ["manual:2", "dismissed"],
      ["risk:TASK-1:old", "dismissed"],
      ["outcome:TASK-1:old", "dismissed"],
      ["manual:1", "done"],
    ],
  );
  assert.equal(
    reconciled.historyItems?.[0]?.prUrl,
    "https://github.com/antonve/pi-agent/pull/123",
  );
  assert.equal(reconciled.historyItems?.[0]?.taskTitle, "TASK-3 title");
});

test("automatic reconciliation records acknowledged risks, completed outcomes, and resolved failures once", () => {
  const riskTask = task("active", "TASK-RISK");
  const completedTask = task("completed", "TASK-DONE");
  const failedTask = task("failed", "TASK-FAIL");
  const initial: TodoBoardState = {
    version: 1,
    manualItems: [],
    resolutions: {},
    pullRequests: {},
    historyItems: [],
  };
  const options = {
    tasks: [riskTask, completedTask, failedTask],
    messagesByTask: new Map([
      [
        riskTask.id,
        [
          message(riskTask.id, "MATERIAL_RISK", 1, {
            summary: "Acknowledged old risk",
          }),
          controlMessage(riskTask.id, "SCOPE_UPDATE", 2),
          message(riskTask.id, "MATERIAL_RISK", 3, {
            summary: "Current risk",
          }),
        ],
      ],
      [
        completedTask.id,
        [
          message(completedTask.id, "TASK_COMPLETED", 1, {
            summary: "Completed result",
          }),
        ],
      ],
      [
        failedTask.id,
        [
          message(failedTask.id, "TASK_FAILED", 1, {
            error: "Historical failure",
          }),
          controlMessage(failedTask.id, "PRIORITY_UPDATE", 2),
        ],
      ],
    ]),
  };
  const derived = buildTodoBoardView({ boardState: initial, ...options });
  const reconciled = reconcileTodoBoardState(initial, derived);
  const repeated = reconcileTodoBoardState(reconciled, derived);
  const restarted = buildTodoBoardView({
    boardState: reconciled,
    ...options,
  });

  assert.equal(repeated, reconciled);
  assert.deepEqual(
    reconciled.historyItems?.map((item) => [
      item.kind,
      item.taskId,
      item.status,
      item.detail,
    ]),
    [
      ["failure", failedTask.id, "acknowledged", "Historical failure"],
      ["risk", riskTask.id, "acknowledged", "Acknowledged old risk"],
      ["outcome", completedTask.id, "completed", "Completed result"],
    ],
  );
  assert.equal(
    restarted.items.find((item) => item.kind === "risk")?.detail,
    "Current risk",
  );
  assert.ok(restarted.historyItems?.every((item) => item.paneId === undefined));
});

test("decision and blocker History timestamps stay tied to durable resolving messages", () => {
  const decisionTask = task("active", "TASK-DECISION");
  const blockerTask = task("active", "TASK-BLOCKER");
  const initial: TodoBoardState = {
    version: 1,
    manualItems: [],
    resolutions: {},
    pullRequests: {},
    historyItems: [],
  };
  const messagesByTask = new Map([
    [
      decisionTask.id,
      [
        message(decisionTask.id, "DECISION_REQUEST", 1, {
          question: "Choose",
        }),
        message(decisionTask.id, "MATERIAL_RISK", 2, {
          summary: "Superseded decision",
        }),
      ],
    ],
    [
      blockerTask.id,
      [
        message(blockerTask.id, "TASK_BLOCKED", 1, {
          summary: "Blocked",
        }),
        message(blockerTask.id, "MATERIAL_RISK", 2, {
          summary: "Superseded blocker",
        }),
      ],
    ],
  ]);
  const derived = buildTodoBoardView({
    boardState: initial,
    tasks: [decisionTask, blockerTask],
    messagesByTask,
  });
  const reconciled = reconcileTodoBoardState(initial, derived);
  const afterFleetMetadataUpdate = buildTodoBoardView({
    boardState: reconciled,
    tasks: [
      { ...decisionTask, updatedAt: 999 },
      { ...blockerTask, updatedAt: 999 },
    ],
    messagesByTask,
  });
  const repeated = reconcileTodoBoardState(
    reconciled,
    afterFleetMetadataUpdate,
  );

  assert.deepEqual(
    reconciled.historyItems
      ?.filter((item) => item.kind === "decision" || item.kind === "blocker")
      .map((item) => [item.kind, item.status, item.resolvedAt]),
    [
      ["blocker", "resolved", 20],
      ["decision", "resolved", 20],
    ],
  );
  assert.equal(repeated, reconciled);
});

test("history pruning is deterministic, newest-first, deduplicated, and capped", () => {
  const historyItems = Array.from(
    { length: TODO_HISTORY_LIMIT + 5 },
    (_, index) => ({
      id: `manual:${index}`,
      source: "manual" as const,
      kind: "manual" as const,
      title: `History ${index}`,
      status: "done" as const,
      resolvedAt: index,
    }),
  );
  historyItems.push({
    ...historyItems[100]!,
    title: "Deduplicated newer record",
    resolvedAt: TODO_HISTORY_LIMIT + 10,
  });
  const state: TodoBoardState = {
    version: 1,
    manualItems: [],
    resolutions: {},
    pullRequests: {},
    historyItems,
  };

  const reconciled = reconcileTodoBoardState(state, {
    generatedCandidates: [],
    automaticHistoryItems: [],
  });

  assert.equal(reconciled.historyItems?.length, TODO_HISTORY_LIMIT);
  assert.equal(reconciled.historyItems?.[0]?.id, "manual:100");
  assert.equal(
    reconciled.historyItems?.[0]?.title,
    "Deduplicated newer record",
  );
  assert.equal(reconciled.historyItems?.at(-1)?.id, "manual:5");
  assert.equal(
    reconcileTodoBoardState(reconciled, {
      generatedCandidates: [],
      automaticHistoryItems: [],
    }),
    reconciled,
  );
});

test("h toggles Active and History with safe selection, scrolling, and PR opening", () => {
  const historyItems = Array.from({ length: 8 }, (_, index) => ({
    id: `history:${index}`,
    kind: "review" as const,
    title: `Archived review ${index} with wrapping detail text`,
    detail: `History detail ${index}`,
    source: "generated" as const,
    historyStatus: "completed" as const,
    prUrl:
      index === 0 ? "https://github.com/antonve/pi-agent/pull/123" : undefined,
    createdAt: 100 - index,
    updatedAt: 100 - index,
  }));
  const view: TodoBoardView = {
    items: [
      {
        id: "manual:active",
        kind: "manual",
        title: "Active item",
        source: "manual",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    historyItems,
    generatedCount: 0,
    manualCount: 1,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [],
  };
  const toggled = handleTodoKey(
    view,
    { showHelp: false, selectedId: "manual:active" },
    "h",
  );
  const selectedHistory = normalizeUiState(view, toggled.state);

  assert.equal(toggled.state.showHistory, true);
  assert.equal(selectedHistory.selectedId, "history:0");
  assert.deepEqual(handleTodoKey(view, selectedHistory, "\r").command, {
    type: "open",
    item: historyItems[0],
  });
  assert.deepEqual(handleTodoKey(view, selectedHistory, "f").command, {
    type: "none",
  });
  assert.deepEqual(handleTodoKey(view, selectedHistory, "d").command, {
    type: "none",
  });

  const lines = renderTodoPane(
    view,
    { showHelp: false, showHistory: true, selectedId: "history:7" },
    32,
    9,
  );
  const plain = lines.map(stripTerminalSequences);
  assert.ok(plain.some((line) => line.includes("to-do · History")));
  assert.ok(plain.some((line) => line.includes("Archived review 7")));
  assert.ok(plain.some((line) => line.startsWith("h Active")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
});

test("rendering stays within width and input flow supports add/edit/snooze", () => {
  const view: TodoBoardView = {
    items: [
      {
        id: "manual:1",
        kind: "manual",
        title: "Very long manual task title that should truncate cleanly",
        detail: "with a detail line that also truncates",
        source: "manual" as const,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    generatedCount: 0,
    manualCount: 1,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [],
  };
  let state: TodoUiState = { showHelp: false };
  state = handleTodoKey(view, state, "a").state;
  assert.equal(state.prompt?.action, "add");
  state = handleTodoKey(view, state, "New").state;
  const added = handleTodoKey(view, state, "\r");
  assert.deepEqual(added.command, { type: "add-manual", title: "New" });

  const edit = handleTodoKey(
    view,
    { showHelp: false, selectedId: "manual:1" },
    "e",
  );
  assert.equal(edit.state.prompt?.action, "edit");
  const snooze = handleTodoKey(
    view,
    { showHelp: false, selectedId: "manual:1" },
    "z",
  );
  assert.equal(snooze.state.prompt?.action, "snooze");

  const lines = renderTodoPane(
    view,
    { showHelp: true, selectedId: "manual:1" },
    28,
    18,
  );
  assert.ok(lines.every((line) => visibleWidth(line) <= 28));
  assert.ok(lines.some((line) => line.includes("Very long manual")));
});

test("long generated and manual items wrap with Unicode display widths and aligned continuations", () => {
  const generatedTitle =
    "Generated review 界🙂 with Unicode and a final generated word";
  const manualTitle =
    "Manual follow-up é with a long unbroken-token-abcdefghijklmnop";
  const view: TodoBoardView = {
    items: [
      {
        id: "generated:1",
        kind: "review",
        title: generatedTitle,
        source: "generated",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "manual:1",
        kind: "manual",
        title: manualTitle,
        source: "manual",
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    generatedCount: 1,
    manualCount: 1,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [],
  };
  const lines = renderTodoPane(
    view,
    { showHelp: false, selectedId: "generated:1" },
    16,
    30,
  );
  const plain = lines.map(stripTerminalSequences);
  const wrappedItem = (heading: string) => {
    const start = plain.indexOf(heading) + 1;
    const end = plain.indexOf("", start);
    return plain.slice(start, end);
  };
  const generated = wrappedItem("Generated");
  const manual = wrappedItem("Manual");

  assert.ok(lines.every((line) => visibleWidth(line) <= 16));
  assert.ok(generated.length > 1);
  assert.ok(manual.length > 1);
  assert.equal(
    generated
      .map((line) => line.slice(5))
      .join("")
      .replace(/\s/gu, ""),
    generatedTitle.replace(/\s/gu, ""),
  );
  assert.equal(
    manual
      .map((line) => line.slice(5))
      .join("")
      .replace(/\s/gu, ""),
    manualTitle.replace(/\s/gu, ""),
  );
  assert.ok(generated.slice(1).every((line) => /^ {5}\S/u.test(line)));
  assert.ok(manual.slice(1).every((line) => /^ {5}\S/u.test(line)));
});

test("item text reflows on resize and keeps every narrow-pane line bounded", () => {
  const title = "Resize this manual item across several words through omega";
  const view: TodoBoardView = {
    items: [
      {
        id: "manual:resize",
        kind: "manual",
        title,
        detail: "Detail text also wraps through its final detail word",
        source: "manual",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    generatedCount: 0,
    manualCount: 1,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [],
  };
  const wide = renderTodoPane(
    view,
    { showHelp: false, selectedId: "manual:resize" },
    30,
    30,
  );
  const narrow = renderTodoPane(
    view,
    { showHelp: false, selectedId: "manual:resize" },
    12,
    30,
  );
  const itemRows = (lines: string[]) => {
    const plain = lines.map(stripTerminalSequences);
    const start = plain.indexOf("Manual") + 1;
    return plain.slice(start, plain.indexOf("", start));
  };
  const wideRows = itemRows(wide);
  const narrowRows = itemRows(narrow);

  assert.ok(narrowRows.length > wideRows.length);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 12));
  assert.ok(narrowRows.slice(1).some((line) => /^ {5}\S/u.test(line)));
  assert.ok(narrowRows.some((line) => /^ {2}Detail/u.test(line)));
  assert.ok(narrowRows.some((line) => line.includes("word")));
});

test("viewport scrolling keeps every wrapped line of the selected item visible", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `manual:${index}`,
    kind: "manual" as const,
    title:
      index === 4
        ? "Selected alpha beta gamma delta omega"
        : `Earlier item ${index} with extra text`,
    source: "manual" as const,
    createdAt: index,
    updatedAt: index,
  }));
  const view: TodoBoardView = {
    items,
    generatedCount: 0,
    manualCount: items.length,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [],
  };
  const lines = renderTodoPane(
    view,
    { showHelp: false, selectedId: "manual:4" },
    18,
    9,
  );
  const plain = lines.map(stripTerminalSequences);

  assert.ok(plain.some((line) => line.startsWith("> M  Selected")));
  assert.ok(plain.some((line) => line.trimEnd().endsWith("omega")));
  assert.ok(plain.some((line) => line.startsWith("h History")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 18));
});

test("generated item controls emit refresh, resolution, focus, and open commands", () => {
  const item = {
    id: "review:TASK-1:message:pr",
    kind: "review" as const,
    title: "Review PR",
    source: "generated" as const,
    taskId: "TASK-1",
    workspaceId: "w-task",
    tabId: "w-task:t1",
    paneId: "w-task:p1",
    prUrl: "https://github.com/antonve/pi-agent/pull/99",
    createdAt: 1,
    updatedAt: 1,
  };
  const view: TodoBoardView = {
    items: [item],
    generatedCount: 1,
    manualCount: 0,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [item.prUrl],
  };
  const state: TodoUiState = { showHelp: false, selectedId: item.id };

  assert.deepEqual(handleTodoKey(view, state, "r").command, {
    type: "refresh",
  });
  assert.deepEqual(handleTodoKey(view, state, "d").command, {
    type: "set-done",
    itemId: item.id,
  });
  assert.deepEqual(handleTodoKey(view, state, "x").command, {
    type: "dismiss",
    itemId: item.id,
  });
  assert.deepEqual(handleTodoKey(view, state, "f").command, {
    type: "focus",
    item,
  });
  assert.deepEqual(handleTodoKey(view, state, "o").command, {
    type: "open",
    item,
  });
  assert.deepEqual(handleTodoKey(view, state, "\r").command, {
    type: "open",
    item,
  });
});

test("rendering keeps the selected item and controls visible in a short pane", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: `manual:${index}`,
    kind: "manual" as const,
    title: `Manual item ${index}`,
    source: "manual" as const,
    createdAt: index,
    updatedAt: index,
  }));
  const view: TodoBoardView = {
    items,
    generatedCount: 0,
    manualCount: items.length,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [],
  };
  const lines = renderTodoPane(
    view,
    { showHelp: false, selectedId: "manual:7" },
    30,
    8,
  );
  assert.ok(lines.some((line) => line.includes("Manual item 7")));
  assert.ok(lines.some((line) => line.includes("h History")));
});

test("board state persists and rejects malformed JSON without overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-first-mate-todo-state-"));
  const path = join(directory, "board.json");
  const store = new TodoBoardStateStore(path);
  await store.update((current) => ({
    ...current,
    manualItems: [
      {
        id: "manual:1",
        title: "Persist me",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }));
  assert.equal((await store.read()).manualItems[0]?.title, "Persist me");

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      manualItems: [],
      resolutions: {},
      pullRequests: {},
    }),
  );
  const migrated = await new TodoBoardStateStore(path).read();
  assert.deepEqual(migrated.historyItems, []);
  await new TodoBoardStateStore(path).update((current) => ({
    ...current,
    historyItems: [
      {
        id: "manual:archived",
        source: "manual",
        kind: "manual",
        title: "Persisted history",
        status: "done",
        resolvedAt: 10,
      },
    ],
  }));
  assert.equal(
    (await new TodoBoardStateStore(path).read()).historyItems?.[0]?.title,
    "Persisted history",
  );

  await writeFile(path, "{invalid");
  await assert.rejects(() => store.read(), /Invalid first-mate to-do state/);
  await assert.rejects(
    () => store.update((current) => current),
    /Invalid first-mate to-do state/,
  );
});

test("fleet and persisted text cannot inject terminal controls", () => {
  const malicious =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u0001";
  assert.equal(sanitizeTodoText(malicious), "beforeafterred");
  assert.equal(
    sanitizeTodoText("line one\n\tline two\u0001"),
    "line one line two",
  );
  const view: TodoBoardView = {
    items: [
      {
        id: "manual:1",
        kind: "manual",
        title: malicious,
        detail: malicious,
        source: "manual",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    generatedCount: 0,
    manualCount: 1,
    snoozedCount: 0,
    hiddenCount: 0,
    trackedPrUrls: [],
  };
  const lines = renderTodoPane(
    view,
    { showHelp: false, status: malicious },
    80,
    10,
  );
  assert.equal(lines.join("\n").includes("\u001b]52"), false);
  assert.equal(lines.join("\n").includes("\u001b[31m"), false);
});

test("snooze parser accepts bounded duration shortcuts", () => {
  const now = 10_000;
  assert.equal(parseSnoozeDuration("30m", now), now + 30 * 60_000);
  assert.equal(parseSnoozeDuration("2h", now), now + 2 * 3_600_000);
  assert.equal(parseSnoozeDuration("1d", now), now + 86_400_000);
  assert.equal(parseSnoozeDuration("tomorrow", now), undefined);
});
