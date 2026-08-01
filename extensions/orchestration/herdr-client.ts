import type { CliRunner } from "./cli.ts";
import { decodeJson, findObjects, findString } from "./cli.ts";
import type {
  CreatedResource,
  Harness,
  ParentLocation,
  ResolvedPlacement,
} from "./domain.ts";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export class HerdrClient {
  private readonly runner: CliRunner;

  constructor(runner: CliRunner) {
    this.runner = runner;
  }

  private async json(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const result = await this.runner.run("herdr", args, options);
    if (result.code !== 0)
      throw new Error(
        `herdr ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return decodeJson(result.stdout, `herdr ${args.join(" ")}`);
  }

  private async exec(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const result = await this.runner.run("herdr", args, options);
    if (result.code !== 0)
      throw new Error(
        `herdr ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout;
  }

  async current(signal?: AbortSignal): Promise<ParentLocation> {
    const value = await this.json(["pane", "current", "--current"], { signal });
    const workspaceId = findString(value, ["workspace_id"]);
    const tabId = findString(value, ["tab_id"]);
    const paneId = findString(value, ["pane_id"]);
    if (!workspaceId || !tabId || !paneId)
      throw new Error(
        "Herdr did not report the current workspace/tab/pane IDs.",
      );
    return { workspaceId, tabId, paneId };
  }

  async createResource(
    parent: ParentLocation,
    placement: ResolvedPlacement,
    cwd: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<CreatedResource> {
    if (placement === "tab") {
      const created = await this.json(
        [
          "tab",
          "create",
          "--workspace",
          parent.workspaceId,
          "--cwd",
          cwd,
          "--label",
          label,
          "--no-focus",
        ],
        { signal },
      );
      const tabId = findString(created, ["tab_id"]);
      if (!tabId)
        throw new Error("Herdr created a tab but returned no tab ID.");
      const panes = await this.json(
        ["pane", "list", "--workspace", parent.workspaceId],
        { signal },
      );
      const pane = findObjects(
        panes,
        (item) => item.tab_id === tabId && typeof item.pane_id === "string",
      )[0];
      const paneId =
        typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
      if (!paneId)
        throw new Error(`Herdr tab ${tabId} has no discoverable pane.`);
      return {
        placement,
        workspaceId: parent.workspaceId,
        tabId,
        paneId,
        createdTab: true,
        createdPane: true,
      };
    }

    const created = await this.json(
      [
        "pane",
        "split",
        "--pane",
        parent.paneId,
        "--direction",
        "right",
        "--ratio",
        "0.5",
        "--cwd",
        cwd,
        "--no-focus",
      ],
      { signal },
    );
    const paneId = findString(created, ["pane_id"]);
    if (!paneId)
      throw new Error("Herdr created a pane but returned no pane ID.");
    await this.json(["pane", "rename", paneId, label], { signal });
    return {
      placement,
      workspaceId: parent.workspaceId,
      tabId: parent.tabId,
      paneId,
      createdTab: false,
      createdPane: true,
    };
  }

  runInPane(
    paneId: string,
    command: string,
    args: string[],
    signal?: AbortSignal,
  ) {
    const commandLine = [command, ...args].map(shellQuote).join(" ");
    return this.exec(["pane", "run", paneId, commandLine], { signal });
  }

  async readPane(paneId: string, lines = 400, signal?: AbortSignal) {
    const result = await this.runner.run(
      "herdr",
      [
        "pane",
        "read",
        paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ],
      { signal, timeoutMs: 10_000 },
    );
    if (result.code !== 0)
      throw new Error(
        `herdr pane read failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout;
  }

  async paneExists(paneId: string) {
    const result = await this.runner.run("herdr", ["pane", "get", paneId], {
      timeoutMs: 5_000,
    });
    return result.code === 0;
  }

  async closeResource(task: {
    createdTab: boolean;
    tabId?: string;
    createdPane: boolean;
    paneId: string;
  }) {
    if (task.createdTab && task.tabId)
      await this.json(["tab", "close", task.tabId]);
    else if (task.createdPane) await this.json(["pane", "close", task.paneId]);
  }

  async focus(task: {
    placement: ResolvedPlacement;
    tabId?: string;
    paneId: string;
    parentPaneId: string;
  }) {
    if (task.tabId) await this.json(["tab", "focus", task.tabId]);
    if (task.placement === "pane")
      await this.json([
        "pane",
        "focus",
        "--pane",
        task.parentPaneId,
        "--direction",
        "right",
      ]);
  }

  sendText(paneId: string, text: string) {
    return this.exec(["pane", "send-text", paneId, text]);
  }
  sendKeys(paneId: string, keys: string[]) {
    return this.exec(["pane", "send-keys", paneId, ...keys]);
  }

  startAgent(
    name: string,
    harness: Harness,
    paneId: string,
    args: string[],
    signal?: AbortSignal,
  ) {
    return this.json(
      [
        "agent",
        "start",
        name,
        "--kind",
        harness,
        "--pane",
        paneId,
        "--timeout",
        "60000",
        ...(args.length ? ["--", ...args] : []),
      ],
      { signal, timeoutMs: 70_000 },
    );
  }
  promptAgent(name: string, prompt: string, signal?: AbortSignal) {
    return this.json(["agent", "prompt", name, prompt], {
      signal,
      timeoutMs: 20_000,
    });
  }
  async getAgent(name: string) {
    const value = await this.json(["agent", "get", name], {
      timeoutMs: 10_000,
    });
    return {
      status: findString(value, ["agent_status"]) ?? "unknown",
      paneId: findString(value, ["pane_id"]),
    };
  }
  async readAgent(name: string, lines = 600) {
    const result = await this.runner.run(
      "herdr",
      [
        "agent",
        "read",
        name,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ],
      { timeoutMs: 10_000 },
    );
    if (result.code !== 0)
      throw new Error(
        `herdr agent read failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout;
  }
  focusAgent(name: string) {
    return this.json(["agent", "focus", name]);
  }
  attachAgent(name: string) {
    return this.runner.run("herdr", ["agent", "attach", name, "--takeover"], {
      timeoutMs: 10_000,
    });
  }
  notify(
    title: string,
    body: string,
    sound: "none" | "done" | "request" = "done",
  ) {
    return this.json([
      "notification",
      "show",
      title,
      "--body",
      body.slice(0, 2_000),
      "--sound",
      sound,
    ]);
  }
}
