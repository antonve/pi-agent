import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stateDirectory } from "./registry.ts";
import { HerdrClient } from "./herdr-client.ts";
import {
  TodoPaneRuntimeStore,
  type TodoPaneRuntimeState,
} from "./first-mate-todo-state.ts";

const BOARD_PROCESS_MARKER = "first-mate-todo-pane-cli.ts";
const BOARD_FINGERPRINT_ARGUMENT = "--todo-runtime-fingerprint";
const BOARD_PANE_LABEL = "firstmate-todo";
const BOARD_WIDTH_RATIO = 0.25;
const BOARD_RESTART_ATTEMPTS = 20;
const BOARD_RESTART_POLL_MS = 50;

// A Pi /reload evaluates this module again. Changing any long-lived board
// source changes the marker, so the controller restarts only its owned CLI.
export const TODO_RUNTIME_FINGERPRINT = createHash("sha256")
  .update(
    [
      "first-mate-todo-pane-cli.ts",
      "first-mate-todo-model.ts",
      "first-mate-todo-state.ts",
      "first-mate-todo-view.ts",
    ]
      .map((name) =>
        readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
      )
      .join("\n--todo-source--\n"),
  )
  .digest("hex")
  .slice(0, 16);

export interface FirstMateTodoPaneLocation {
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string;
}

export interface FirstMateTodoPaneEnsureResult {
  paneId: string;
  created: boolean;
  restarted: boolean;
}

interface BoardPaneCandidate {
  paneId: string;
  label?: string;
  x: number;
  commandLine?: string;
}

function boardCommand() {
  const scriptPath = fileURLToPath(
    new URL("./first-mate-todo-pane-cli.ts", import.meta.url),
  );
  return {
    command: "env",
    args: [
      `PI_HERDR_STATE_DIR=${stateDirectory()}`,
      process.execPath,
      "--experimental-strip-types",
      scriptPath,
      `${BOARD_FINGERPRINT_ARGUMENT}=${TODO_RUNTIME_FINGERPRINT}`,
    ],
  };
}

function processMatchesBoard(commandLine: string | undefined) {
  return (
    typeof commandLine === "string" &&
    commandLine.includes(BOARD_PROCESS_MARKER)
  );
}

function processMatchesCurrentBoard(commandLine: string | undefined) {
  return (
    processMatchesBoard(commandLine) &&
    commandLine!.includes(
      `${BOARD_FINGERPRINT_ARGUMENT}=${TODO_RUNTIME_FINGERPRINT}`,
    )
  );
}

function processIsIdleShell(commandLine: string | undefined) {
  if (!commandLine) return true;
  const parts = commandLine.trim().split(/\s+/);
  if (parts.length !== 1) return false;
  const command = parts[0]?.split("/").at(-1);
  return (
    command === "sh" ||
    command === "bash" ||
    command === "dash" ||
    command === "zsh" ||
    command === "fish"
  );
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class FirstMateTodoPaneController {
  private pending: Promise<FirstMateTodoPaneEnsureResult> | undefined;
  private readonly herdr: HerdrClient;
  private readonly runtime: TodoPaneRuntimeStore;

  constructor(herdr: HerdrClient, runtime = new TodoPaneRuntimeStore()) {
    this.herdr = herdr;
    this.runtime = runtime;
  }

  async ensure(location: FirstMateTodoPaneLocation) {
    if (this.pending) return this.pending;
    this.pending = this.runtime
      .withEnsureLock(() => this.ensureUnlocked(location))
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async ensureUnlocked(location: FirstMateTodoPaneLocation) {
    const runtime = await this.runtime.read();
    if (
      runtime.paneId &&
      (runtime.workspaceId !== location.workspaceId ||
        runtime.tabId !== location.tabId)
    )
      await this.closeIfManaged(runtime.paneId);

    const candidates = await this.findOwnedPanes(location, runtime);
    const keeper = this.selectKeeper(candidates, runtime);
    if (keeper) {
      const restarted = await this.ensureProcess(keeper.paneId, {
        commandLine: keeper.commandLine,
      });
      await this.closeOwnedDuplicates(candidates, keeper.paneId);
      await this.saveRuntime(location, keeper.paneId);
      return { paneId: keeper.paneId, created: false, restarted };
    }

    const created = await this.herdr.splitPane(location.paneId, location.cwd, {
      direction: "right",
      // Herdr applies the split ratio to the original (left) pane.
      ratio: 1 - BOARD_WIDTH_RATIO,
      noFocus: true,
    });
    await this.herdr.renamePane(created.paneId, BOARD_PANE_LABEL);
    await this.ensureProcess(created.paneId);
    await this.saveRuntime(location, created.paneId);
    return { paneId: created.paneId, created: true, restarted: true };
  }

  private async saveRuntime(
    location: FirstMateTodoPaneLocation,
    paneId: string,
  ) {
    const next: TodoPaneRuntimeState = {
      version: 1,
      paneId,
      parentPaneId: location.paneId,
      tabId: location.tabId,
      workspaceId: location.workspaceId,
      startedAt: Date.now(),
      fingerprint: TODO_RUNTIME_FINGERPRINT,
    };
    await this.runtime.write(next);
  }

  private async closeIfManaged(paneId: string) {
    const process = await this.herdr.processInfo(paneId).catch(() => undefined);
    if (!processMatchesBoard(process?.foregroundCommandLine)) return;
    await this.herdr.closePane(paneId).catch(() => undefined);
  }

  private async findOwnedPanes(
    location: FirstMateTodoPaneLocation,
    runtime: TodoPaneRuntimeState,
  ) {
    const [layout, listedPanes] = await Promise.all([
      this.herdr.layout(location.paneId),
      this.herdr.listPanes(location.workspaceId),
    ]);
    if (
      layout.workspaceId !== location.workspaceId ||
      layout.tabId !== location.tabId
    )
      throw new Error(
        `First-mate to-do pane location changed from ${location.workspaceId}/${location.tabId}.`,
      );
    const panesInClaimedTab = new Map(
      listedPanes
        .filter((pane) => pane.tabId === location.tabId)
        .map((pane) => [pane.paneId, pane]),
    );
    const candidates: BoardPaneCandidate[] = [];
    for (const pane of layout.panes) {
      if (pane.paneId === location.paneId) continue;
      const label = panesInClaimedTab.get(pane.paneId)?.label;
      let commandLine: string | undefined;
      try {
        commandLine = (await this.herdr.processInfo(pane.paneId))
          .foregroundCommandLine;
      } catch (error) {
        if (pane.paneId === runtime.paneId || label === BOARD_PANE_LABEL)
          throw new Error(
            `Could not inspect first-mate to-do pane candidate ${pane.paneId}.`,
            { cause: error },
          );
        continue;
      }
      if (label === BOARD_PANE_LABEL || processMatchesBoard(commandLine))
        candidates.push({
          paneId: pane.paneId,
          label,
          x: pane.rect.x,
          commandLine,
        });
    }
    return candidates.sort(
      (left, right) =>
        right.x - left.x || left.paneId.localeCompare(right.paneId),
    );
  }

  private selectKeeper(
    candidates: BoardPaneCandidate[],
    runtime: TodoPaneRuntimeState,
  ) {
    const valid = candidates.filter(
      (candidate) =>
        processMatchesBoard(candidate.commandLine) ||
        (candidate.label === BOARD_PANE_LABEL &&
          processIsIdleShell(candidate.commandLine)),
    );
    return (
      valid.find((candidate) => candidate.paneId === runtime.paneId) ?? valid[0]
    );
  }

  private async closeOwnedDuplicates(
    candidates: BoardPaneCandidate[],
    keeperPaneId: string,
  ) {
    for (const candidate of candidates) {
      if (candidate.paneId === keeperPaneId) continue;
      const process = await this.herdr
        .processInfo(candidate.paneId)
        .catch(() => undefined);
      if (!process) continue;
      if (
        processMatchesBoard(process?.foregroundCommandLine) ||
        (candidate.label === BOARD_PANE_LABEL &&
          processIsIdleShell(process?.foregroundCommandLine))
      )
        await this.herdr.closePane(candidate.paneId).catch(() => undefined);
    }
  }

  private async ensureProcess(
    paneId: string,
    inspected?: { commandLine?: string },
  ) {
    let commandLine = inspected
      ? inspected.commandLine
      : (await this.herdr.processInfo(paneId).catch(() => undefined))
          ?.foregroundCommandLine;
    if (processMatchesCurrentBoard(commandLine)) return false;
    if (processMatchesBoard(commandLine)) {
      await this.herdr.sendKeys(paneId, ["ctrl+c"]);
      for (let attempt = 0; attempt < BOARD_RESTART_ATTEMPTS; attempt++) {
        await delay(BOARD_RESTART_POLL_MS);
        commandLine = (await this.herdr.processInfo(paneId))
          .foregroundCommandLine;
        if (!processMatchesBoard(commandLine)) break;
      }
      if (processMatchesBoard(commandLine))
        throw new Error(
          `Timed out stopping outdated first-mate to-do process in ${paneId}.`,
        );
    } else if (!processIsIdleShell(commandLine)) {
      throw new Error(
        `Refusing to replace unrelated process in first-mate to-do pane ${paneId}.`,
      );
    }
    const command = boardCommand();
    await this.herdr.runInPane(paneId, command.command, command.args);
    return true;
  }
}
