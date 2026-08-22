import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  discoverTreehouseLease,
  type CommandResult,
  type CommandRunner,
} from "./free.ts";

const NAME_SYSTEM_PROMPT = `Generate a random tab label.

Requirements:
- Return only the label, with no quotes or explanation.
- Use one to three short lowercase English words joined by hyphens.
- Keep it under 32 characters.
- Make it unrelated to the conversation or current task.

Examples: horse-race, rand-goal, fitness`;

export interface CreatedHerdrTab {
  tabId: string;
  paneId: string;
}

export interface PitabDependencies {
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  generateName(ctx: ExtensionCommandContext): Promise<string>;
  agentName(): string;
}

function outputError(result: CommandResult, fallback: string) {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function findString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys)
    if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findString(item, keys);
        if (found) return found;
      }
    } else {
      const found = findString(child, keys);
      if (found) return found;
    }
  }
  return undefined;
}

export function normalizeGeneratedTabName(value: string) {
  const words = value
    .trim()
    .replace(/^[`'"\s]+|[`'"\s]+$/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3);
  while (words.join("-").length > 32 && words.length > 1) words.pop();
  const label = words.join("-").slice(0, 32).replace(/-+$/g, "");
  if (!label) throw new Error("The model did not generate a usable tab name.");
  return label;
}

export function parseCreatedHerdrTab(output: string): CreatedHerdrTab {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(
      `herdr tab create returned invalid JSON: ${output.slice(0, 500)}`,
    );
  }
  const tabId = findString(value, ["tab_id", "tabId"]);
  const paneId = findString(value, ["pane_id", "paneId"]);
  if (!tabId || !paneId)
    throw new Error(
      "Herdr created a tab without returning its tab and pane IDs.",
    );
  return { tabId, paneId };
}

export async function resolvePitabRepository(
  cwd: string,
  runner: CommandRunner,
) {
  const repository = await runner.run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  if (repository.code !== 0 || !repository.stdout.trim())
    throw new Error(outputError(repository, "Not inside a Git repository."));
  const repositoryRoot = resolve(repository.stdout.trim());
  const lease = await discoverTreehouseLease(repositoryRoot, runner);
  return lease?.originalRepository ?? repositoryRoot;
}

export async function generateRandomTabName(ctx: ExtensionCommandContext) {
  if (!ctx.model) throw new Error("No model selected for tab-name generation.");
  const message: Message = {
    role: "user",
    content: [{ type: "text", text: "Generate one random tab label now." }],
    timestamp: Date.now(),
  };
  const response = await ctx.modelRegistry.complete(
    ctx.model,
    { systemPrompt: NAME_SYSTEM_PROMPT, messages: [message] },
    {
      cacheRetention: "none",
      sessionId: uuidv7(),
    },
  );
  if (response.stopReason === "aborted")
    throw new Error("Tab-name generation was cancelled.");
  const text = response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join(" ");
  return normalizeGeneratedTabName(text);
}

export function randomPitabAgentName() {
  return `pitab-${randomBytes(6).toString("hex")}`;
}

export async function runPitab(
  rawName: string,
  ctx: ExtensionCommandContext,
  dependencies: PitabDependencies,
) {
  if (
    dependencies.env.HERDR_ENV !== "1" ||
    !dependencies.env.HERDR_WORKSPACE_ID
  )
    throw new Error("/pitab requires Pi to be running inside Herdr.");

  const repository = await resolvePitabRepository(ctx.cwd, dependencies.runner);
  const suppliedName = rawName.trim();
  const label = suppliedName || (await dependencies.generateName(ctx));
  const created = await dependencies.runner.run(
    "herdr",
    [
      "tab",
      "create",
      "--workspace",
      dependencies.env.HERDR_WORKSPACE_ID,
      "--cwd",
      repository,
      "--label",
      label,
      "--no-focus",
    ],
    { cwd: repository },
  );
  if (created.code !== 0)
    throw new Error(outputError(created, "Could not create the Herdr tab."));
  const tab = parseCreatedHerdrTab(created.stdout);

  const started = await dependencies.runner.run(
    "herdr",
    [
      "agent",
      "start",
      dependencies.agentName(),
      "--kind",
      "pi",
      "--pane",
      tab.paneId,
      "--timeout",
      "60000",
    ],
    { cwd: repository, timeoutMs: 65_000 },
  );
  if (started.code !== 0) {
    await dependencies.runner.run("herdr", ["tab", "close", tab.tabId]);
    throw new Error(outputError(started, "Pi failed to start in the new tab."));
  }

  const focused = await dependencies.runner.run("herdr", [
    "tab",
    "focus",
    tab.tabId,
  ]);
  if (focused.code !== 0)
    throw new Error(
      outputError(
        focused,
        `Pi started, but Herdr could not focus ${tab.tabId}.`,
      ),
    );
  return { ...tab, label, repository };
}
