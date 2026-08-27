import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TodoBoardView, TodoItem } from "./first-mate-todo-model.ts";

// Remove terminal controls from fleet, GitHub, and persisted user text before
// applying this view's trusted styling.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeTodoText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

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
  showHistory?: boolean;
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
  | { type: "focus"; item: TodoItem };

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
  if (!item.prUrl && item.paneId) return "focus";
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
  if (data.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(data)) {
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

function displayedView(view: TodoBoardView, state: TodoUiState) {
  return state.showHistory ? { ...view, items: view.historyItems ?? [] } : view;
}

function selectedItem(view: TodoBoardView, state: TodoUiState) {
  return (
    view.items.find((item) => item.id === state.selectedId) ?? view.items[0]
  );
}

export function normalizeUiState(view: TodoBoardView, state: TodoUiState) {
  const displayed = displayedView(view, state);
  if (displayed.items.length === 0) return { ...state, selectedId: undefined };
  if (
    state.selectedId &&
    displayed.items.some((item) => item.id === state.selectedId)
  )
    return state;
  return { ...state, selectedId: displayed.items[0]!.id };
}

export function handleTodoKey(
  view: TodoBoardView,
  state: TodoUiState,
  data: string,
  now = Date.now(),
): { state: TodoUiState; command: TodoUiCommand } {
  const normalized = normalizeUiState(view, state);
  const displayed = displayedView(view, normalized);
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
        selectedId: moveSelection(displayed, normalized.selectedId, -1),
      },
      command: { type: "none" },
    };
  if (matchesKey(data, Key.down) || data === "j")
    return {
      state: {
        ...normalized,
        selectedId: moveSelection(displayed, normalized.selectedId, 1),
      },
      command: { type: "none" },
    };
  if (data === "?")
    return {
      state: { ...normalized, showHelp: !normalized.showHelp },
      command: { type: "none" },
    };
  if (data === "h")
    return {
      state: {
        ...normalized,
        showHistory: !normalized.showHistory,
        selectedId: undefined,
        status: undefined,
      },
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

  const item = selectedItem(displayed, normalized);
  if (!item)
    return {
      state: normalized,
      command: { type: "none" },
    };

  if (
    normalized.showHistory &&
    (data === "d" || data === "x" || data === "z" || data === "e")
  )
    return {
      state: { ...normalized, status: "History items are read-only." },
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
  if (data === "f" && item.paneId)
    return {
      state: {
        ...normalized,
        status: `Focusing ${item.taskId ?? item.title}...`,
      },
      command: { type: "focus", item },
    };
  if (matchesKey(data, Key.enter) && primaryAction(item) === "focus")
    return {
      state: {
        ...normalized,
        status: `Focusing ${item.taskId ?? item.title}...`,
      },
      command: { type: "focus", item },
    };
  return { state: normalized, command: { type: "none" } };
}

function renderPrompt(prompt: PromptState, width: number) {
  const labels = {
    add: "Add: ",
    edit: "Edit: ",
    snooze: "Snooze (30m/1h/1d): ",
  } as const;
  const beforeCursor =
    labels[prompt.action] +
    sanitizeTodoText(prompt.value.slice(0, prompt.cursor));
  const atCursor =
    sanitizeTodoText(prompt.value.slice(prompt.cursor, prompt.cursor + 1)) ||
    " ";
  const afterCursor = sanitizeTodoText(prompt.value.slice(prompt.cursor + 1));
  return truncateToWidth(
    beforeCursor + ansi.inverse(atCursor) + afterCursor,
    width,
  );
}

function wrapWithPrefix(
  prefix: string,
  text: string,
  width: number,
  style: (value: string) => string = (value) => value,
) {
  const prefixWidth = visibleWidth(prefix);
  if (width <= prefixWidth)
    return wrapTextWithAnsi(`${prefix}${style(text)}`, Math.max(1, width));
  const indent = " ".repeat(prefixWidth);
  return wrapTextWithAnsi(text, width - prefixWidth).map((line, index) =>
    truncateToWidth(`${index === 0 ? prefix : indent}${style(line)}`, width),
  );
}

export const TODO_COMPACT_CHARACTER_LIMIT = 100;
export const TODO_COMPACT_LINE_LIMIT = 3;

function truncateCharacters(text: string, limit: number) {
  const characters = Array.from(text);
  if (characters.length <= limit) return { text, truncated: false };
  if (limit <= 0) return { text: "", truncated: true };
  return {
    text: characters
      .slice(0, Math.max(0, limit - 1))
      .join("")
      .trimEnd(),
    truncated: true,
  };
}

function compactItemText(item: TodoItem) {
  const title = sanitizeTodoText(item.title);
  const detail = item.detail ? sanitizeTodoText(item.detail) : undefined;
  const compactTitle = truncateCharacters(title, TODO_COMPACT_CHARACTER_LIMIT);
  const remaining = Math.max(
    0,
    TODO_COMPACT_CHARACTER_LIMIT - Array.from(compactTitle.text).length - 1,
  );
  const compactDetail = detail
    ? truncateCharacters(detail, remaining)
    : undefined;
  return {
    title: compactTitle.text,
    detail: compactDetail?.text || undefined,
    truncated:
      compactTitle.truncated ||
      compactDetail?.truncated === true ||
      (detail !== undefined && compactDetail?.text.length === 0),
  };
}

function appendEllipsis(line: string, width: number) {
  return truncateToWidth(`${line}${ansi.dim("…")}`, width, "…");
}

function renderItem(item: TodoItem, selected: boolean, width: number) {
  const marker = selected ? ansi.inverse(">") : " ";
  const titlePrefix = `${marker} ${ansi.bold(kindTag(item))} `;
  const text = selected
    ? {
        title: sanitizeTodoText(item.title),
        detail: item.detail ? sanitizeTodoText(item.detail) : undefined,
        truncated: false,
      }
    : compactItemText(item);
  let lines = wrapWithPrefix(titlePrefix, text.title, width);
  if (text.detail)
    lines.push(...wrapWithPrefix("  ", text.detail, width, ansi.dim));
  if (!selected) {
    const overflowed = lines.length > TODO_COMPACT_LINE_LIMIT;
    lines = lines.slice(0, TODO_COMPACT_LINE_LIMIT);
    if ((text.truncated || overflowed) && lines.length > 0)
      lines[lines.length - 1] = appendEllipsis(lines[lines.length - 1]!, width);
  }
  if (item.kind === "review" && item.prUrl)
    lines.push(...wrapWithPrefix("  ", sanitizeTodoText(item.prUrl), width));
  return lines;
}

export function renderTodoPane(
  view: TodoBoardView,
  state: TodoUiState,
  width: number,
  height: number,
) {
  const normalized = normalizeUiState(view, state);
  const displayed = displayedView(view, normalized);
  const mode = normalized.showHistory ? "History" : "Active";
  const header: string[] = [
    truncateToWidth(
      `${ansi.bold(`First-mate to-do · ${mode}`)} ${ansi.dim(
        normalized.showHistory
          ? `${displayed.items.length} archived`
          : `${displayed.items.length} visible · ${view.hiddenCount} hidden`,
      )}`,
      width,
    ),
  ];
  if (normalized.status)
    header.push(
      truncateToWidth(ansi.dim(sanitizeTodoText(normalized.status)), width),
    );
  else if (!normalized.showHistory && view.snoozedCount > 0)
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
      "enter focus task",
      "f focus task",
      "select/copy PR URL",
      "d done · x dismiss · z snooze",
      "a add · e edit manual",
      "h Active/History",
      "r refresh · ? help",
    ];
    for (const line of help)
      header.push(truncateToWidth(ansi.dim(line), width));
    header.push("");
  }

  const body: string[] = [];
  let selectedStart = 0;
  let selectedEnd = 0;
  const appendItems = (source: TodoItem["source"], heading: string) => {
    const items = displayed.items.filter((item) => item.source === source);
    if (items.length === 0) return;
    body.push(truncateToWidth(ansi.bold(heading), width));
    for (const item of items) {
      const itemLines = renderItem(
        item,
        item.id === normalized.selectedId,
        width,
      );
      if (item.id === normalized.selectedId) {
        selectedStart = body.length;
        selectedEnd = body.length + itemLines.length - 1;
      }
      body.push(...itemLines, "");
    }
  };
  if (normalized.showHistory) {
    if (displayed.items.length > 0) {
      body.push(truncateToWidth(ansi.bold("History"), width));
      for (const item of displayed.items) {
        const itemLines = renderItem(
          item,
          item.id === normalized.selectedId,
          width,
        );
        if (item.id === normalized.selectedId) {
          selectedStart = body.length;
          selectedEnd = body.length + itemLines.length - 1;
        }
        body.push(...itemLines, "");
      }
    }
  } else {
    appendItems("generated", "Generated");
    appendItems("manual", "Manual");
  }
  if (displayed.items.length === 0)
    body.push(
      truncateToWidth(
        ansi.dim(
          normalized.showHistory
            ? "No history yet. Press h for Active."
            : "No items. Press a to add one.",
        ),
        width,
      ),
    );

  const footer = [
    truncateToWidth("─".repeat(Math.max(0, width)), width),
    normalized.prompt
      ? renderPrompt(normalized.prompt, width)
      : truncateToWidth(
          ansi.dim(
            normalized.showHistory
              ? "h Active · ? help"
              : "h History · enter focus · ? help",
          ),
          width,
        ),
  ];
  const bodyHeight = Math.max(0, height - header.length - footer.length);
  const maxStart = Math.max(0, body.length - bodyHeight);
  const selectedHeight = selectedEnd - selectedStart + 1;
  let bodyStart = Math.min(
    maxStart,
    Math.max(
      0,
      selectedStart - Math.floor(Math.max(0, bodyHeight - selectedHeight) / 2),
    ),
  );
  if (selectedEnd >= bodyStart + bodyHeight)
    bodyStart = Math.min(maxStart, selectedEnd - bodyHeight + 1);
  if (selectedStart < bodyStart) bodyStart = selectedStart;
  const visibleBody = body.slice(bodyStart, bodyStart + bodyHeight);
  while (visibleBody.length < bodyHeight) visibleBody.push("");
  return [...header, ...visibleBody, ...footer].slice(0, Math.max(0, height));
}
