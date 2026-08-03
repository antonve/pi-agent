import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import calmToolOutput from "./index.ts";

function registeredTools() {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  calmToolOutput(pi);
  return tools;
}

function component(
  tools: Map<string, ToolDefinition>,
  name: string,
  args: object,
) {
  const ui = { requestRender() {} } as unknown as TUI;
  return new ToolExecutionComponent(
    name,
    `${name}-call`,
    args,
    undefined,
    tools.get(name),
    ui,
    "/tmp",
  );
}

function visibleLines(value: ToolExecutionComponent) {
  // Strip ANSI styling before checking whether a rendered row has content.
  return value
    .render(120)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
}

initTheme("dark", false);

test("read stays zero-height until Ctrl+O expansion", () => {
  const read = component(registeredTools(), "read", { path: "/tmp/file" });
  read.updateResult({
    content: [{ type: "text", text: "contents" }],
    isError: false,
  });
  assert.deepEqual(visibleLines(read), []);

  read.setExpanded(true);
  assert.ok(visibleLines(read).some((line) => line.includes("/tmp/file")));
  assert.ok(visibleLines(read).some((line) => line.includes("contents")));
});

test("compact built-ins retain the call and reveal results with Ctrl+O", () => {
  const bash = component(registeredTools(), "bash", { command: "printf ok" });
  bash.updateResult({
    content: [{ type: "text", text: "ok" }],
    details: { command: "printf ok", exitCode: 0 },
    isError: false,
  });
  assert.equal(visibleLines(bash).length, 1);
  assert.match(visibleLines(bash)[0]!, /printf ok/);

  bash.setExpanded(true);
  assert.ok(visibleLines(bash).some((line) => line === "ok"));
});

test("collapsed failures remain visible", () => {
  const read = component(registeredTools(), "read", { path: "/missing" });
  read.updateResult({
    content: [{ type: "text", text: "File not found" }],
    isError: true,
  });
  assert.ok(visibleLines(read).some((line) => line.includes("/missing")));
  assert.ok(visibleLines(read).some((line) => line.includes("File not found")));
});
