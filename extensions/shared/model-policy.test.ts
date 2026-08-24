import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_MODELS,
  FIRST_MATE_DEFAULT,
  resolveSecondMatePolicy,
  resolveSummaryPolicy,
  resolveWorkerPolicy,
  REVIEW_SCOPE_GUARD,
} from "./model-policy.ts";

test("role defaults select approved direct models and preferred reasoning", () => {
  assert.deepEqual(FIRST_MATE_DEFAULT, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoning: "medium",
  });
  assert.deepEqual(resolveSecondMatePolicy(), {
    model: APPROVED_MODELS.sol,
    reasoning: "high",
  });
  assert.deepEqual(resolveWorkerPolicy({ harness: "codex" }), {
    role: "implementation",
    harness: "codex",
    model: "gpt-5.6-sol",
    canonicalModel: APPROVED_MODELS.sol,
    family: "sol",
    reasoning: "high",
  });
  assert.equal(
    resolveWorkerPolicy({ harness: "claude" }).model,
    APPROVED_MODELS.fable,
  );
  assert.equal(
    resolveWorkerPolicy({ role: "data-processing", harness: "pi" }).model,
    APPROVED_MODELS.luna,
  );
});

test("persistent second mates reject model and reasoning overrides", () => {
  assert.throws(
    () => resolveSecondMatePolicy({ model: "openai-codex/gpt-5.5" }),
    /persistent second mates require openai-codex\/gpt-5\.6-sol/,
  );
  assert.throws(
    () => resolveSecondMatePolicy({ reasoning: "xhigh" }),
    /persistent second mates require high reasoning/,
  );
});

test("implementation allowlist enforces providers, harnesses, and thinking levels", () => {
  assert.equal(
    resolveWorkerPolicy({
      harness: "pi",
      model: APPROVED_MODELS.grok,
    }).reasoning,
    "high",
  );
  assert.equal(
    resolveWorkerPolicy({
      harness: "claude",
      model: APPROVED_MODELS.fable,
      reasoning: "max",
    }).family,
    "fable",
  );
  assert.equal(
    resolveWorkerPolicy({
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
    }).canonicalModel,
    APPROVED_MODELS.sol,
  );
  assert.throws(
    () =>
      resolveWorkerPolicy({
        harness: "pi",
        model: "openrouter/openai/gpt-5.6-sol",
      }),
    /GPT-5\.6 must use the direct openai-codex route/,
  );
  assert.throws(
    () => resolveWorkerPolicy({ harness: "pi", model: "openai/gpt-5.5" }),
    /older or unapproved OpenAI model .* is banned/,
  );
  assert.throws(
    () =>
      resolveWorkerPolicy({
        harness: "pi",
        model: "openrouter/anthropic/claude-fable-5",
      }),
    /Fable must use exact model claude-fable-5 through the Claude Code harness/,
  );
  assert.throws(
    () =>
      resolveWorkerPolicy({
        harness: "claude",
        model: APPROVED_MODELS.fable,
        reasoning: "medium",
      }),
    /require reasoning high or xhigh or max/,
  );
  assert.throws(
    () => resolveWorkerPolicy({ harness: "opencode" }),
    /sol cannot run through opencode/,
  );
});

test("data-processing routes are narrow and reject implementation models", () => {
  assert.equal(
    resolveWorkerPolicy({
      role: "data-processing",
      harness: "codex",
      reasoning: "xhigh",
    }).model,
    "gpt-5.6-luna",
  );
  assert.equal(
    resolveWorkerPolicy({
      role: "data-processing",
      harness: "pi",
      model: APPROVED_MODELS.deepseek,
    }).family,
    "deepseek",
  );
  assert.throws(
    () =>
      resolveWorkerPolicy({
        role: "data-processing",
        harness: "pi",
        model: APPROVED_MODELS.sol,
      }),
    /sol is not approved for data-processing/,
  );
  assert.throws(
    () =>
      resolveWorkerPolicy({
        role: "data-processing",
        harness: "pi",
        model: APPROVED_MODELS.deepseek,
        reasoning: "xhigh",
      }),
    /deepseek data-processing workers require reasoning high/,
  );
});

test("review policy defaults across Sol and Fable and rejects same-family review", () => {
  assert.equal(
    resolveWorkerPolicy({
      role: "review",
      harness: "claude",
      reviewTargetModel: APPROVED_MODELS.sol,
    }).model,
    APPROVED_MODELS.fable,
  );
  assert.equal(
    resolveWorkerPolicy({
      role: "review",
      harness: "codex",
      reviewTargetModel: APPROVED_MODELS.fable,
    }).canonicalModel,
    APPROVED_MODELS.sol,
  );
  assert.equal(
    resolveWorkerPolicy({
      role: "review",
      harness: "pi",
      model: APPROVED_MODELS.grok,
      reviewTargetModel: APPROVED_MODELS.sol,
    }).family,
    "grok",
  );
  assert.throws(
    () => resolveWorkerPolicy({ role: "review", harness: "claude" }),
    /review workers require review_target_model/,
  );
  assert.throws(
    () =>
      resolveWorkerPolicy({
        role: "review",
        harness: "codex",
        model: "gpt-5.6-sol",
        reviewTargetModel: APPROVED_MODELS.sol,
      }),
    /reviewer family sol must differ from reviewed family sol/,
  );
});

test("summaries are fixed to direct Luna high", () => {
  assert.deepEqual(resolveSummaryPolicy(), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoning: "high",
  });
  assert.throws(
    () =>
      resolveSummaryPolicy({
        provider: "openrouter",
        model: "openai/gpt-5.6-luna",
        reasoning: "high",
      }),
    /summarization requires openai-codex\/gpt-5\.6-luna at high/,
  );
  assert.throws(
    () => resolveSummaryPolicy({ reasoning: "medium" }),
    /summarization requires .* at high reasoning/,
  );
});

test("review scope guard prohibits edits and scope expansion", () => {
  assert.match(REVIEW_SCOPE_GUARD, /Review only the supplied change/);
  assert.match(REVIEW_SCOPE_GUARD, /Do not modify files/);
  assert.match(
    REVIEW_SCOPE_GUARD,
    /scope-expanding suggestions as out of scope/,
  );
});
