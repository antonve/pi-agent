import assert from "node:assert/strict";
import test from "node:test";
import { shouldRenderToolPart } from "./calm-tool-output.ts";

test("collapsed hidden tools occupy no call or result rows", () => {
  assert.equal(shouldRenderToolPart("hidden", "call", false, false), false);
  assert.equal(shouldRenderToolPart("hidden", "result", false, false), false);
});

test("collapsed compact tools retain only their call row", () => {
  assert.equal(shouldRenderToolPart("compact", "call", false, false), true);
  assert.equal(shouldRenderToolPart("compact", "result", false, false), false);
});

test("Ctrl+O expansion and failures restore every tool part", () => {
  for (const mode of ["hidden", "compact"] as const) {
    for (const part of ["call", "result"] as const) {
      assert.equal(shouldRenderToolPart(mode, part, true, false), true);
      assert.equal(shouldRenderToolPart(mode, part, false, true), true);
    }
  }
});
