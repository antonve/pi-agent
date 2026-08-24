import { fileURLToPath } from "node:url";
import { stateDirectory } from "./registry.ts";
import { HerdrClient } from "./herdr-client.ts";
import {
  TodoPaneRuntimeStore,
  type TodoPaneRuntimeState,
} from "./first-mate-todo-state.ts";

const BOARD_PROCESS_MARKER = "first-mate-todo-pane-cli.ts";
const BOARD_RATIO = 0.22;

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
    ],
  };
}

function processMatchesBoard(commandLine: string | undefined) {
  return (
    typeof commandLine === "string" &&
    commandLine.includes(BOARD_PROCESS_MARKER)
  );
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
    this.pending = this.ensureUnlocked(location).finally(() => {
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

    const paneId = await this.findExistingPane(location, runtime);
    if (paneId) {
      const restarted = await this.ensureProcess(paneId);
      await this.ensureFarRight(location, paneId);
      await this.saveRuntime(location, paneId);
      return { paneId, created: false, restarted };
    }

    const created = await this.herdr.splitPane(location.paneId, location.cwd, {
      direction: "right",
      ratio: BOARD_RATIO,
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
    )
      return runtime.paneId;

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
    const process = await this.herdr.processInfo(paneId).catch(() => undefined);
    if (processMatchesBoard(process?.foregroundCommandLine)) return false;
    const command = boardCommand();
    await this.herdr.runInPane(paneId, command.command, command.args);
    return true;
  }
}
