import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUMMARY_CONFIG, parseSummaryConfig } from "./src/config.ts";

test("summary config defaults to direct Codex Luna at high reasoning", () => {
  assert.deepEqual(parseSummaryConfig(undefined), DEFAULT_SUMMARY_CONFIG);
  assert.deepEqual(DEFAULT_SUMMARY_CONFIG, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoning: "high",
  });
});

test("summary config accepts only the approved fixed route", () => {
  assert.deepEqual(
    parseSummaryConfig({
      provider: " openai-codex ",
      model: " gpt-5.6-luna ",
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.throws(
    () =>
      parseSummaryConfig({
        provider: "openrouter",
        model: "openai/gpt-5.6-luna",
        reasoning: "high",
      }),
    /Model policy violation/,
  );

  assert.deepEqual(
    parseSummaryConfig({ provider: "", model: 42, reasoning: "turbo" }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: 42,
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
});
