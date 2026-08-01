import type { Harness, ReasoningLevel } from "./domain.ts";

const CHILD_DISABLED_TOOLS =
  "subagent_spawn,subagent_wait,subagent_check,subagent_list,subagent_cancel,subagent_send,workflow,ask_user";

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

export function buildHarnessLaunch(options: HarnessOptions): HarnessLaunch {
  if (options.harness === "pi") {
    const model = options.model ?? options.parentModel;
    const reasoning = options.reasoning ?? options.parentReasoning;
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
    const model = options.model ?? "fable";
    const reasoning = options.reasoning ?? "high";
    return {
      kind: "claude",
      model,
      reasoning,
      args: [
        "--model",
        model,
        "--effort",
        reasoning === "off" || reasoning === "minimal" ? "low" : reasoning,
      ],
    };
  }
  if (options.harness === "codex") {
    const model = options.model ?? "gpt-5.6-sol";
    const reasoning = options.reasoning ?? "high";
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
        model,
        "--config",
        `model_reasoning_effort=\"${effort}\"`,
      ],
    };
  }
  return {
    kind: "opencode",
    model: options.model,
    reasoning: options.reasoning,
    args: options.model ? ["--model", options.model] : [],
  };
}
