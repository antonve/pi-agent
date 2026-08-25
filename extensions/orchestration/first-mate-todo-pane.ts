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
  const command = commandLine.trim().split(/\s+/, 1)[0]?.split("/").at(-1);
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
    this.pending = this.ensurePreservingFocus(location).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async ensurePreservingFocus(location: FirstMateTodoPaneLocation) {
    const focusedPaneId = await this.herdr
      .focusedPaneId()
      .catch(() => undefined);
    try {
      return await this.ensureUnlocked(location);
    } finally {
      if (focusedPaneId) {
        const currentPaneId = await this.herdr
          .focusedPaneId()
          .catch(() => undefined);
        if (currentPaneId !== focusedPaneId)
          await this.herdr.focusPane(focusedPaneId);
      }
    }
  }

  private async ensureUnlocked(location: FirstMateTodoPaneLocation) {
    const runtime = await this.runtime.read();
    if (
      runtime.paneId &&
      (runtime.workspaceId !== location.workspaceId ||
        runtime.tabId !== location.tabId)
    )
      await this.closeIfManaged(runtime.paneId);

    const paneId = await this.findExistingPane(location, runtime);
    if (paneId) {
      const restarted = await this.ensureProcess(paneId);
      await this.ensureFarRight(location, paneId);
      await this.saveRuntime(location, paneId);
      return { paneId, created: false, restarted };
    }

    const created = await this.herdr.splitPane(location.paneId, location.cwd, {
      direction: "right",
      // Herdr applies the split ratio to the original (left) pane.
      ratio: 1 - BOARD_WIDTH_RATIO,
      noFocus: true,
    });
    await this.herdr.renamePane(created.paneId, "firstmate-todo");
    await this.ensureProcess(created.paneId);
    await this.ensureFarRight(location, created.paneId);
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

  private async findExistingPane(
    location: FirstMateTodoPaneLocation,
    runtime: TodoPaneRuntimeState,
  ) {
    if (
      runtime.paneId &&
      runtime.workspaceId === location.workspaceId &&
      runtime.tabId === location.tabId &&
      (await this.herdr.paneExists(runtime.paneId).catch(() => false))
    ) {
      const process = await this.herdr
        .processInfo(runtime.paneId)
        .catch(() => undefined);
      if (
        processMatchesBoard(process?.foregroundCommandLine) ||
        processIsIdleShell(process?.foregroundCommandLine)
      )
        return runtime.paneId;
    }

    const layout = await this.herdr
      .layout(location.paneId)
      .catch(() => undefined);
    if (!layout) return undefined;
    const candidates = [...layout.panes].sort(
      (left, right) => right.rect.x - left.rect.x,
    );
    for (const candidate of candidates) {
      const process = await this.herdr
        .processInfo(candidate.paneId)
        .catch(() => undefined);
      if (processMatchesBoard(process?.foregroundCommandLine))
        return candidate.paneId;
    }
    return undefined;
  }

  private async ensureFarRight(
    location: FirstMateTodoPaneLocation,
    paneId: string,
  ) {
    const layout = await this.herdr
      .layout(location.paneId)
      .catch(() => undefined);
    const board = layout?.panes.find((pane) => pane.paneId === paneId);
    const rightmost = layout?.panes.reduce((current, pane) =>
      pane.rect.x + pane.rect.width > current.rect.x + current.rect.width
        ? pane
        : current,
    );
    if (
      !board ||
      !rightmost ||
      board.rect.x + board.rect.width >= rightmost.rect.x + rightmost.rect.width
    )
      return;
    await this.herdr.swapPanes(paneId, rightmost.paneId);
  }

  private async ensureProcess(paneId: string) {
    let process = await this.herdr.processInfo(paneId).catch(() => undefined);
    if (processMatchesCurrentBoard(process?.foregroundCommandLine))
      return false;
    if (processMatchesBoard(process?.foregroundCommandLine)) {
      await this.herdr.sendKeys(paneId, ["ctrl+c"]);
      for (let attempt = 0; attempt < BOARD_RESTART_ATTEMPTS; attempt++) {
        await delay(BOARD_RESTART_POLL_MS);
        process = await this.herdr.processInfo(paneId).catch(() => undefined);
        if (!processMatchesBoard(process?.foregroundCommandLine)) break;
      }
      if (processMatchesBoard(process?.foregroundCommandLine))
        throw new Error(
          `Timed out stopping outdated first-mate to-do process in ${paneId}.`,
        );
    } else if (!processIsIdleShell(process?.foregroundCommandLine)) {
      throw new Error(
        `Refusing to replace unrelated process in first-mate to-do pane ${paneId}.`,
      );
    }
    const command = boardCommand();
    await this.herdr.runInPane(paneId, command.command, command.args);
    return true;
  }
}
