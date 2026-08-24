import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { FleetMessage, FleetTask } from "./fleet.ts";
import {
  buildTodoBoardView,
  parseSnoozeDuration,
  type TodoBoardView,
} from "./first-mate-todo-model.ts";
import {
  renderTodoPane,
  handleTodoKey,
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
      ["outcome", "TASK-1"],
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
    14,
  );
  assert.ok(lines.every((line) => visibleWidth(line) <= 28));
  assert.ok(lines.some((line) => line.includes("Manual")));
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
  assert.ok(lines.some((line) => line.includes("enter open/focus")));
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

  await writeFile(path, "{invalid");
  await assert.rejects(() => store.read(), /Invalid first-mate to-do state/);
  await assert.rejects(
    () => store.update((current) => current),
    /Invalid first-mate to-do state/,
  );
});

test("snooze parser accepts bounded duration shortcuts", () => {
  const now = 10_000;
  assert.equal(parseSnoozeDuration("30m", now), now + 30 * 60_000);
  assert.equal(parseSnoozeDuration("2h", now), now + 2 * 3_600_000);
  assert.equal(parseSnoozeDuration("1d", now), now + 86_400_000);
  assert.equal(parseSnoozeDuration("tomorrow", now), undefined);
});
