import assert from "node:assert/strict";
import test from "node:test";
import { hideThemesSection } from "./index.ts";

interface FakeNode {
  children?: FakeNode[];
  invalidated: boolean;
  invalidate(): void;
  render(width?: number): string[];
}

function node(text: string, children?: FakeNode[]): FakeNode {
  return {
    children,
    invalidated: false,
    invalidate() {
      this.invalidated = true;
    },
    render() {
      return [text];
    },
  };
}

test("guarded traversal removes only the exact Themes section", () => {
  const themes = node("[Themes]");
  const blank = node("");
  const similarlyNamed = node("[Themes preview]");
  const root = node("root", [similarlyNamed, themes, blank, node("[Tools]")]);
  assert.equal(hideThemesSection(root), true);
  assert.deepEqual(
    root.children?.map((child) => child.render(80)[0]),
    ["[Themes preview]", "[Tools]"],
  );
  assert.equal(root.invalidated, true);
});

test("guarded traversal fails harmlessly when render throws", () => {
  const broken = node("");
  broken.render = () => {
    throw new Error("disposed");
  };
  const root = node("root", [broken]);
  assert.equal(hideThemesSection(root), false);
});
