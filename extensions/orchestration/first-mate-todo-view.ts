import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoBoardView, TodoItem } from "./first-mate-todo-model.ts";

const ansi = {
  bold: (value: string) => `\u001b[1m${value}\u001b[22m`,
  dim: (value: string) => `\u001b[2m${value}\u001b[22m`,
  red: (value: string) => `\u001b[31m${value}\u001b[39m`,
  green: (value: string) => `\u001b[32m${value}\u001b[39m`,
  yellow: (value: string) => `\u001b[33m${value}\u001b[39m`,
  blue: (value: string) => `\u001b[34m${value}\u001b[39m`,
  magenta: (value: string) => `\u001b[35m${value}\u001b[39m`,
  cyan: (value: string) => `\u001b[36m${value}\u001b[39m`,
  inverse: (value: string) => `\u001b[7m${value}\u001b[27m`,
};

export interface PromptState {
  action: "add" | "edit" | "snooze";
  value: string;
  cursor: number;
  targetId?: string;
}

export interface TodoUiState {
  selectedId?: string;
  prompt?: PromptState;
  showHelp: boolean;
  status?: string;
}

export type TodoUiCommand =
  | { type: "none" }
  | { type: "refresh" }
  | { type: "set-done"; itemId: string }
  | { type: "dismiss"; itemId: string }
  | { type: "snooze"; itemId: string; value: string }
  | { type: "add-manual"; title: string }
  | { type: "edit-manual"; itemId: string; title: string }
  | { type: "focus"; item: TodoItem }
  | { type: "open"; item: TodoItem };

function kindTag(item: TodoItem) {
  switch (item.kind) {
    case "review":
      return ansi.blue("PR");
    case "decision":
      return ansi.yellow("Q ");
    case "risk":
      return ansi.magenta("R ");
    case "blocker":
      return ansi.yellow("B ");
    case "failure":
      return ansi.red("F ");
    case "outcome":
      return ansi.green("OK");
    case "manual":
      return ansi.cyan("M ");
  }
}

function primaryAction(item: TodoItem) {
  if (item.prUrl) return "open";
  if (item.workspaceId) return "focus";
  return undefined;
}

function moveSelection(
  view: TodoBoardView,
  selectedId: string | undefined,
  direction: -1 | 1,
) {
  if (view.items.length === 0) return undefined;
  const current = view.items.findIndex((item) => item.id === selectedId);
  if (current < 0) return view.items[0]!.id;
  const next = Math.min(
    view.items.length - 1,
    Math.max(0, current + direction),
  );
  return view.items[next]!.id;
}

function applyPromptEdit(prompt: PromptState, data: string) {
  if (matchesKey(data, Key.left)) {
    return { ...prompt, cursor: Math.max(0, prompt.cursor - 1) };
  }
  if (matchesKey(data, Key.right)) {
    return {
      ...prompt,
      cursor: Math.min(prompt.value.length, prompt.cursor + 1),
    };
  }
  if (matchesKey(data, Key.home)) return { ...prompt, cursor: 0 };
  if (matchesKey(data, Key.end)) {
    return { ...prompt, cursor: prompt.value.length };
  }
  if (matchesKey(data, Key.backspace)) {
    if (prompt.cursor === 0) return prompt;
    return {
      ...prompt,
      value:
        prompt.value.slice(0, prompt.cursor - 1) +
        prompt.value.slice(prompt.cursor),
      cursor: prompt.cursor - 1,
    };
  }
  if (matchesKey(data, Key.delete)) {
    if (prompt.cursor >= prompt.value.length) return prompt;
    return {
      ...prompt,
      value:
        prompt.value.slice(0, prompt.cursor) +
        prompt.value.slice(prompt.cursor + 1),
    };
  }
  if (data.length > 0 && !/[\u0000-\u001f\u007f]/u.test(data)) {
    return {
      ...prompt,
      value:
        prompt.value.slice(0, prompt.cursor) +
        data +
        prompt.value.slice(prompt.cursor),
      cursor: prompt.cursor + data.length,
    };
  }
  return prompt;
}

function selectedItem(view: TodoBoardView, state: TodoUiState) {
  return (
    view.items.find((item) => item.id === state.selectedId) ?? view.items[0]
  );
}

export function normalizeUiState(view: TodoBoardView, state: TodoUiState) {
  if (view.items.length === 0) return { ...state, selectedId: undefined };
  if (
    state.selectedId &&
    view.items.some((item) => item.id === state.selectedId)
  )
    return state;
  return { ...state, selectedId: view.items[0]!.id };
}

export function handleTodoKey(
  view: TodoBoardView,
  state: TodoUiState,
  data: string,
  now = Date.now(),
): { state: TodoUiState; command: TodoUiCommand } {
  const normalized = normalizeUiState(view, state);
  if (normalized.prompt) {
    if (matchesKey(data, Key.escape))
      return {
        state: { ...normalized, prompt: undefined },
        command: { type: "none" },
      };
    if (matchesKey(data, Key.enter)) {
      const value = normalized.prompt.value.trim();
      if (!value)
        return {
          state: { ...normalized, prompt: undefined, status: "Cancelled." },
          command: { type: "none" },
        };
      if (normalized.prompt.action === "add")
        return {
          state: {
            ...normalized,
            prompt: undefined,
            status: "Added manual item.",
          },
          command: { type: "add-manual", title: value },
        };
      if (normalized.prompt.action === "edit" && normalized.prompt.targetId)
        return {
          state: {
            ...normalized,
            prompt: undefined,
            status: "Updated manual item.",
          },
          command: {
            type: "edit-manual",
            itemId: normalized.prompt.targetId,
            title: value,
          },
        };
      return {
        state: { ...normalized, prompt: undefined, status: "Snoozed item." },
        command: {
          type: "snooze",
          itemId: normalized.prompt.targetId!,
          value,
        },
      };
    }
    return {
      state: {
        ...normalized,
        prompt: applyPromptEdit(normalized.prompt, data),
      },
      command: { type: "none" },
    };
  }

  if (matchesKey(data, Key.up) || data === "k")
    return {
      state: {
        ...normalized,
        selectedId: moveSelection(view, normalized.selectedId, -1),
      },
      command: { type: "none" },
    };
  if (matchesKey(data, Key.down) || data === "j")
    return {
      state: {
        ...normalized,
        selectedId: moveSelection(view, normalized.selectedId, 1),
      },
      command: { type: "none" },
    };
  if (data === "?")
    return {
      state: { ...normalized, showHelp: !normalized.showHelp },
      command: { type: "none" },
    };
  if (data === "r")
    return {
      state: { ...normalized, status: "Refreshing..." },
      command: { type: "refresh" },
    };
  if (data === "a")
    return {
      state: {
        ...normalized,
        prompt: { action: "add", value: "", cursor: 0 },
        status: undefined,
      },
      command: { type: "none" },
    };

  const item = selectedItem(view, normalized);
  if (!item)
    return {
      state: normalized,
      command: { type: "none" },
    };

  if (data === "d")
    return {
      state: { ...normalized, status: "Marked done." },
      command: { type: "set-done", itemId: item.id },
    };
  if (data === "x")
    return {
      state: { ...normalized, status: "Dismissed." },
      command: { type: "dismiss", itemId: item.id },
    };
  if (data === "e") {
    if (item.kind !== "manual")
      return {
        state: { ...normalized, status: "Only manual items are editable." },
        command: { type: "none" },
      };
    return {
      state: {
        ...normalized,
        prompt: {
          action: "edit",
          value: item.title,
          cursor: item.title.length,
          targetId: item.id,
        },
        status: undefined,
      },
      command: { type: "none" },
    };
  }
  if (data === "z")
    return {
      state: {
        ...normalized,
        prompt: {
          action: "snooze",
          value: "1h",
          cursor: 2,
          targetId: item.id,
        },
        status: undefined,
      },
      command: { type: "none" },
    };
  if (data === "f" && item.workspaceId)
    return {
      state: {
        ...normalized,
        status: `Focusing ${item.taskId ?? item.title}...`,
      },
      command: { type: "focus", item },
    };
  if (data === "o" && item.prUrl)
    return {
      state: { ...normalized, status: `Opening ${item.prUrl}...` },
      command: { type: "open", item },
    };
  if (matchesKey(data, Key.enter)) {
    const action = primaryAction(item);
    if (action === "focus")
      return {
        state: {
          ...normalized,
          status: `Focusing ${item.taskId ?? item.title}...`,
        },
        command: { type: "focus", item },
      };
    if (action === "open")
      return {
        state: { ...normalized, status: `Opening ${item.prUrl}...` },
        command: { type: "open", item },
      };
  }
  return { state: normalized, command: { type: "none" } };
}

function renderPrompt(prompt: PromptState, width: number) {
  const labels = {
    add: "Add: ",
    edit: "Edit: ",
    snooze: "Snooze (30m/1h/1d): ",
  } as const;
  const text = labels[prompt.action] + prompt.value;
  const beforeCursor = text.slice(
    0,
    labels[prompt.action].length + prompt.cursor,
  );
  const atCursor = text[labels[prompt.action].length + prompt.cursor] ?? " ";
  const afterCursor = text.slice(
    labels[prompt.action].length + prompt.cursor + 1,
  );
  return truncateToWidth(
    beforeCursor + ansi.inverse(atCursor) + afterCursor,
    width,
  );
}

function renderItem(item: TodoItem, selected: boolean, width: number) {
  const prefix = selected ? ansi.inverse(">") : " ";
  const title = `${prefix} ${ansi.bold(kindTag(item))} ${item.title}`;
  const lines = [truncateToWidth(title, width)];
  if (item.detail)
    lines.push(truncateToWidth(`  ${ansi.dim(item.detail)}`, width));
  return lines;
}

export function renderTodoPane(
  view: TodoBoardView,
  state: TodoUiState,
  width: number,
  height: number,
) {
  const normalized = normalizeUiState(view, state);
  const header: string[] = [
    truncateToWidth(
      `${ansi.bold("First-mate to-do")} ${ansi.dim(`${view.items.length} visible · ${view.hiddenCount} hidden`)}`,
      width,
    ),
  ];
  if (normalized.status)
    header.push(truncateToWidth(ansi.dim(normalized.status), width));
  else if (view.snoozedCount > 0)
    header.push(
      truncateToWidth(
        ansi.dim(
          `${view.snoozedCount} snoozed item${view.snoozedCount === 1 ? "" : "s"}`,
        ),
        width,
      ),
    );
  else header.push("");

  if (normalized.showHelp) {
    const help = [
      "j/k or arrows move",
      "enter primary action",
      "f focus task",
      "o open PR",
      "d done · x dismiss · z snooze",
      "a add · e edit manual",
      "r refresh · ? help",
    ];
    for (const line of help)
      header.push(truncateToWidth(ansi.dim(line), width));
    header.push("");
  }

  const body: string[] = [];
  let selectedLine = 0;
  const appendItems = (source: TodoItem["source"], heading: string) => {
    const items = view.items.filter((item) => item.source === source);
    if (items.length === 0) return;
    body.push(truncateToWidth(ansi.bold(heading), width));
    for (const item of items) {
      if (item.id === normalized.selectedId) selectedLine = body.length;
      body.push(
        ...renderItem(item, item.id === normalized.selectedId, width),
        "",
      );
    }
  };
  appendItems("generated", "Generated");
  appendItems("manual", "Manual");
  if (view.items.length === 0)
    body.push(
      truncateToWidth(ansi.dim("No items. Press a to add one."), width),
    );

  const footer = [
    truncateToWidth("─".repeat(Math.max(0, width)), width),
    normalized.prompt
      ? renderPrompt(normalized.prompt, width)
      : truncateToWidth(ansi.dim("enter open/focus · ? help"), width),
  ];
  const bodyHeight = Math.max(0, height - header.length - footer.length);
  const maxStart = Math.max(0, body.length - bodyHeight);
  const bodyStart = Math.min(
    maxStart,
    Math.max(0, selectedLine - Math.floor(bodyHeight / 2)),
  );
  const visibleBody = body.slice(bodyStart, bodyStart + bodyHeight);
  while (visibleBody.length < bodyHeight) visibleBody.push("");
  return [...header, ...visibleBody, ...footer].slice(0, Math.max(0, height));
}
