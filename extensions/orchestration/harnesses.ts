import type { Harness, ReasoningLevel } from "./domain.ts";

const CHILD_DISABLED_TOOLS =
  "background_wait,bg_start,bg_status,bg_list,bg_kill,subagent_spawn,subagent_wait,subagent_check,subagent_list,subagent_cancel,subagent_send,resource_pin,worker_spawn,worker_wait,worker_check,worker_list,worker_cancel,worker_send,workflow,ask_user,task_assign,task_list,task_send,task_cancel,mate_register,raise_decision,complete_task,fail_task";

export interface HarnessOptions {
  harness: Harness;
  model?: string;
  reasoning?: ReasoningLevel;
  parentModel?: string;
  parentReasoning?: ReasoningLevel;
}

export interface HarnessLaunch {
  kind: Harness;
  args: string[];
  model?: string;
  reasoning?: ReasoningLevel;
}

export interface HeadlessHarnessOptions extends HarnessOptions {
  sessionId?: string;
  resultPath: string;
  resume?: boolean;
}

export interface HeadlessHarnessLaunch extends HarnessLaunch {
  command: string;
  promptDelivery: "stdin" | "argument";
  sessionId?: string;
}

function resolvedHarness(options: HarnessOptions) {
  if (options.harness === "pi") {
    return {
      model: options.model ?? options.parentModel,
      reasoning: options.reasoning ?? options.parentReasoning,
    };
  }
  if (options.harness === "claude") {
    return {
      model: options.model ?? "fable",
      reasoning: options.reasoning ?? "high",
    };
  }
  if (options.harness === "codex") {
    return {
      model: options.model ?? "gpt-5.6-sol",
      reasoning: options.reasoning ?? "high",
    };
  }
  return { model: options.model, reasoning: options.reasoning };
}

export function buildHarnessLaunch(options: HarnessOptions): HarnessLaunch {
  const { model, reasoning } = resolvedHarness(options);
  if (options.harness === "pi") {
    return {
      kind: "pi",
      model,
      reasoning,
      args: [
        ...(model ? ["--model", model] : []),
        ...(reasoning ? ["--thinking", reasoning] : []),
        "--exclude-tools",
        CHILD_DISABLED_TOOLS,
      ],
    };
  }
  if (options.harness === "claude") {
    return {
      kind: "claude",
      model,
      reasoning,
      args: [
        "--model",
        model!,
        "--effort",
        reasoning === "off" || reasoning === "minimal" ? "low" : reasoning!,
      ],
    };
  }
  if (options.harness === "codex") {
    const effort =
      reasoning === "off"
        ? "minimal"
        : reasoning === "max"
          ? "xhigh"
          : reasoning;
    return {
      kind: "codex",
      model,
      reasoning,
      args: [
        "--model",
        model!,
        "--config",
        `model_reasoning_effort=\"${effort}\"`,
      ],
    };
  }
  return {
    kind: "opencode",
    model,
    reasoning,
    args: model ? ["--model", model] : [],
  };
}

/** Build a process-per-turn invocation. The prompt is supplied by the runner,
 * never by typing into an interactive harness UI. */
export function buildHeadlessHarnessLaunch(
  options: HeadlessHarnessOptions,
): HeadlessHarnessLaunch {
  const { model, reasoning } = resolvedHarness(options);
  if (options.harness === "pi") {
    return {
      kind: "pi",
      command: "pi",
      model,
      reasoning,
      sessionId: options.sessionId,
      promptDelivery: "stdin",
      args: [
        "--mode",
        "json",
        "--approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        ...(options.sessionId ? ["--session-id", options.sessionId] : []),
        ...(model ? ["--model", model] : []),
        ...(reasoning ? ["--thinking", reasoning] : []),
        "--exclude-tools",
        CHILD_DISABLED_TOOLS,
      ],
    };
  }
  if (options.harness === "claude") {
    return {
      kind: "claude",
      command: "claude",
      model,
      reasoning,
      sessionId: options.sessionId,
      promptDelivery: "stdin",
      args: [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--model",
        model!,
        "--effort",
        reasoning === "off" || reasoning === "minimal" ? "low" : reasoning!,
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--disallowedTools",
        "Task",
        "TaskOutput",
        "TaskStop",
        "Agent",
        ...(options.resume && options.sessionId
          ? ["--resume", options.sessionId]
          : []),
      ],
    };
  }
  if (options.harness === "codex") {
    const effort =
      reasoning === "off"
        ? "minimal"
        : reasoning === "max"
          ? "xhigh"
          : reasoning;
    const common = [
      "--model",
      model!,
      "--config",
      `model_reasoning_effort=\"${effort}\"`,
      "--config",
      "features.multi_agent=false",
      "--config",
      "features.multi_agent_v2=false",
      "--config",
      "mcp_servers={}",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
    ];
    const turn =
      options.resume && options.sessionId
        ? [
            "exec",
            "resume",
            "--json",
            "--output-last-message",
            options.resultPath,
            options.sessionId,
            "-",
          ]
        : ["exec", "--json", "--output-last-message", options.resultPath, "-"];
    return {
      kind: "codex",
      command: "codex",
      model,
      reasoning,
      sessionId: options.sessionId,
      promptDelivery: "stdin",
      args: [...common, ...turn],
    };
  }
  return {
    kind: "opencode",
    command: "opencode",
    model,
    reasoning,
    sessionId: options.sessionId,
    promptDelivery: "argument",
    args: [
      "run",
      "--pure",
      "--format",
      "json",
      "--auto",
      ...(model ? ["--model", model] : []),
      ...(reasoning ? ["--variant", reasoning] : []),
      ...(options.resume && options.sessionId
        ? ["--session", options.sessionId]
        : []),
    ],
  };
}

export function extractHarnessSessionId(
  harness: Harness,
  output: string,
  fallback?: string,
) {
  if (harness === "pi" && fallback) return fallback;
  const keys =
    harness === "codex"
      ? ["thread_id", "threadId"]
      : harness === "opencode"
        ? ["sessionID", "sessionId", "session_id"]
        : ["session_id", "sessionId"];
  for (const line of output.split(/\r?\n/)) {
    try {
      const value: unknown = JSON.parse(line);
      const found = findNestedString(value, keys);
      if (found) return found;
    } catch {
      // Harnesses may mix diagnostic text with their structured stream.
    }
  }
  return fallback;
}

function findNestedString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys)
    if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = findNestedString(child, keys);
    if (found) return found;
  }
  return undefined;
}

export function extractStructuredText(output: string) {
  const messages: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const value: unknown = JSON.parse(line);
      collectFinalAssistantText(value, messages);
    } catch {
      // Keep the raw stream as a fallback below.
    }
  }
  return messages.length ? messages.at(-1)! : output;
}

function collectFinalAssistantText(value: unknown, output: string[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFinalAssistantText(item, output));
    return;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const role = typeof record.role === "string" ? record.role : undefined;
  if (
    role === "assistant" ||
    type === "assistant" ||
    type === "assistant_message" ||
    type === "message_end" ||
    type === "result"
  ) {
    const text = textContent(record.content ?? record.text ?? record.message);
    if (text) output.push(text);
  }
  for (const child of Object.values(record)) {
    if (typeof child === "string" && child.includes("PI_PARENT_REPORT_BEGIN"))
      output.push(child);
    else collectFinalAssistantText(child, output);
  }
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const values = value.map(textContent).filter((item) => item !== undefined);
    return values.length ? values.join("\n") : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return textContent(record.content ?? record.message);
}
