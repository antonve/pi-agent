export const POLICY_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PolicyReasoningLevel = (typeof POLICY_REASONING_LEVELS)[number];

export const WORKER_ROLES = [
  "implementation",
  "data-processing",
  "review",
] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export type PolicyHarness = "pi" | "claude" | "codex" | "opencode";
export type ModelFamily = "sol" | "fable" | "grok" | "luna" | "deepseek";

export const APPROVED_MODELS = {
  sol: "openai-codex/gpt-5.6-sol",
  fable: "claude-fable-5",
  grok: "openrouter/x-ai/grok-4.6",
  luna: "openai-codex/gpt-5.6-luna",
  deepseek: "openrouter/deepseek/deepseek-v4-flash-0731",
} as const;

export const FIRST_MATE_DEFAULT = {
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
} as const;

export const SECOND_MATE_DEFAULT = {
  model: APPROVED_MODELS.sol,
  reasoning: "high",
} as const;

export const SUMMARY_DEFAULT = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "high",
} as const;

export const REVIEW_SCOPE_GUARD = `Review scope guard:
- Review only the supplied change against its stated requirements and acceptance criteria.
- Do not modify files or propose unrelated refactors, cleanup, features, or broader hardening.
- Treat scope-expanding suggestions as out of scope and do not act on them.
- Return only in-scope findings, verification gaps, and a concise verdict.`;

interface ModelIdentity {
  family: ModelFamily;
  canonicalModel: string;
}

export interface ResolvedWorkerPolicy extends ModelIdentity {
  role: WorkerRole;
  harness: PolicyHarness;
  model: string;
  reasoning: PolicyReasoningLevel;
}

function policyError(message: string): never {
  throw new Error(`Model policy violation: ${message}`);
}

function identityFor(harness: PolicyHarness, requested: string): ModelIdentity {
  const model = requested.trim();
  if (!model) return policyError("model must not be empty.");

  if (
    model === APPROVED_MODELS.sol ||
    (harness === "codex" && model === "gpt-5.6-sol")
  )
    return { family: "sol", canonicalModel: APPROVED_MODELS.sol };
  if (
    model === APPROVED_MODELS.luna ||
    (harness === "codex" && model === "gpt-5.6-luna")
  )
    return { family: "luna", canonicalModel: APPROVED_MODELS.luna };
  if (model === APPROVED_MODELS.fable)
    return { family: "fable", canonicalModel: APPROVED_MODELS.fable };
  if (model === APPROVED_MODELS.grok)
    return { family: "grok", canonicalModel: APPROVED_MODELS.grok };
  if (model === APPROVED_MODELS.deepseek)
    return { family: "deepseek", canonicalModel: APPROVED_MODELS.deepseek };

  if (/^openrouter\/.+gpt-5\.6/i.test(model))
    return policyError(
      `GPT-5.6 must use the direct openai-codex route, not ${model}.`,
    );
  if (/gpt-|(?:^|\/)o[134](?:-|$)/i.test(model))
    return policyError(
      `older or unapproved OpenAI model ${model} is banned; use direct GPT-5.6 Sol or Luna for an approved role.`,
    );
  if (/fable|claude/i.test(model))
    return policyError(
      `Fable must use exact model ${APPROVED_MODELS.fable} through the Claude Code harness.`,
    );
  return policyError(`${model} is not approved for orchestration.`);
}

export function modelFamily(model: string): ModelFamily {
  const trimmed = model.trim();
  if (trimmed === "gpt-5.6-sol") return "sol";
  if (trimmed === "gpt-5.6-luna") return "luna";
  return identityFor(
    trimmed === APPROVED_MODELS.fable ? "claude" : "pi",
    trimmed,
  ).family;
}

function defaultModel(
  role: WorkerRole,
  harness: PolicyHarness,
  reviewTargetModel?: string,
) {
  if (role === "data-processing") return APPROVED_MODELS.luna;
  if (role === "review") {
    if (!reviewTargetModel)
      return policyError("review workers require review_target_model.");
    return modelFamily(reviewTargetModel) === "fable"
      ? APPROVED_MODELS.sol
      : APPROVED_MODELS.fable;
  }
  if (harness === "claude") return APPROVED_MODELS.fable;
  return APPROVED_MODELS.sol;
}

function assertHarness(harness: PolicyHarness, family: ModelFamily) {
  const allowed: Record<ModelFamily, readonly PolicyHarness[]> = {
    sol: ["pi", "codex"],
    luna: ["pi", "codex"],
    fable: ["claude"],
    grok: ["pi"],
    deepseek: ["pi"],
  };
  if (!allowed[family].includes(harness))
    policyError(
      `${family} cannot run through ${harness}; approved harnesses: ${allowed[family].join(", ")}.`,
    );
}

function assertRole(role: WorkerRole, family: ModelFamily) {
  const allowed: Record<WorkerRole, readonly ModelFamily[]> = {
    implementation: ["sol", "fable", "grok"],
    "data-processing": ["luna", "deepseek"],
    review: ["sol", "fable", "grok"],
  };
  if (!allowed[role].includes(family))
    policyError(
      `${family} is not approved for ${role}; approved families: ${allowed[role].join(", ")}.`,
    );
}

function allowedReasoning(role: WorkerRole, family: ModelFamily) {
  if (family === "grok" || family === "deepseek") return ["high"] as const;
  if (family === "luna") return ["high", "xhigh"] as const;
  if (role === "implementation" || role === "review")
    return ["high", "xhigh", "max"] as const;
  return ["high"] as const;
}

function launchModel(harness: PolicyHarness, identity: ModelIdentity) {
  if (harness === "codex") {
    if (identity.family === "sol") return "gpt-5.6-sol";
    if (identity.family === "luna") return "gpt-5.6-luna";
  }
  return identity.canonicalModel;
}

export function resolveWorkerPolicy(options: {
  role?: WorkerRole;
  harness: PolicyHarness;
  model?: string;
  reasoning?: PolicyReasoningLevel;
  reviewTargetModel?: string;
}): ResolvedWorkerPolicy {
  const role = options.role ?? "implementation";
  const requested =
    options.model ??
    defaultModel(role, options.harness, options.reviewTargetModel);
  const identity = identityFor(options.harness, requested);
  assertHarness(options.harness, identity.family);
  assertRole(role, identity.family);

  if (role === "review") {
    if (!options.reviewTargetModel)
      policyError("review workers require review_target_model.");
    const targetFamily = modelFamily(options.reviewTargetModel);
    if (targetFamily === identity.family)
      policyError(
        `reviewer family ${identity.family} must differ from reviewed family ${targetFamily}.`,
      );
  } else if (options.reviewTargetModel !== undefined) {
    policyError("review_target_model is valid only for review workers.");
  }

  const reasoning = options.reasoning ?? "high";
  const allowed = allowedReasoning(role, identity.family);
  if (!(allowed as readonly string[]).includes(reasoning))
    policyError(
      `${identity.family} ${role} workers require reasoning ${allowed.join(" or ")}; received ${reasoning}.`,
    );

  return {
    role,
    harness: options.harness,
    model: launchModel(options.harness, identity),
    canonicalModel: identity.canonicalModel,
    family: identity.family,
    reasoning,
  };
}

export function resolveSecondMatePolicy(
  options: {
    model?: string;
    reasoning?: PolicyReasoningLevel;
  } = {},
) {
  const model = options.model ?? SECOND_MATE_DEFAULT.model;
  const reasoning = options.reasoning ?? SECOND_MATE_DEFAULT.reasoning;
  if (model !== SECOND_MATE_DEFAULT.model)
    policyError(
      `persistent second mates require ${SECOND_MATE_DEFAULT.model}; received ${model}.`,
    );
  if (reasoning !== SECOND_MATE_DEFAULT.reasoning)
    policyError(
      `persistent second mates require high reasoning; received ${reasoning}.`,
    );
  return SECOND_MATE_DEFAULT;
}

export function resolveSummaryPolicy(
  options: {
    provider?: string;
    model?: string;
    reasoning?: PolicyReasoningLevel;
  } = {},
) {
  const resolved = {
    provider: options.provider ?? SUMMARY_DEFAULT.provider,
    model: options.model ?? SUMMARY_DEFAULT.model,
    reasoning: options.reasoning ?? SUMMARY_DEFAULT.reasoning,
  };
  if (
    resolved.provider !== SUMMARY_DEFAULT.provider ||
    resolved.model !== SUMMARY_DEFAULT.model ||
    resolved.reasoning !== SUMMARY_DEFAULT.reasoning
  )
    policyError(
      `summarization requires ${SUMMARY_DEFAULT.provider}/${SUMMARY_DEFAULT.model} at ${SUMMARY_DEFAULT.reasoning} reasoning.`,
    );
  return SUMMARY_DEFAULT;
}
