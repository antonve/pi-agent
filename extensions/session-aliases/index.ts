import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEmptySession, nodeCommandRunner, runFree } from "./free.ts";
import {
  generateRandomTabName,
  randomPitabAgentName,
  runPitab,
} from "./pitab.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("free", {
    description:
      "Clear the chat, free a Treehouse lease, and rename the Herdr tab",
    handler: async (_args, ctx) => {
      await runFree(ctx, {
        runner: nodeCommandRunner,
        env: process.env,
        createEmptySession,
        chdir: (cwd) => process.chdir(cwd),
      });
    },
  });

  pi.registerCommand("pitab", {
    description: "Open Pi in a new Herdr tab for the same repository",
    handler: async (args, ctx) => {
      const generatingName = !args.trim();
      if (generatingName) ctx.ui.setStatus("pitab", "Generating tab name…");
      try {
        await runPitab(args, ctx, {
          runner: nodeCommandRunner,
          env: process.env,
          generateName: generateRandomTabName,
          agentName: randomPitabAgentName,
        });
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      } finally {
        if (generatingName) ctx.ui.setStatus("pitab", undefined);
      }
    },
  });

  pi.registerCommand("pull", {
    description: "Pull the repository's main worktree",
    handler: async (_args, ctx) => {
      const worktrees = await pi.exec(
        "git",
        ["worktree", "list", "--porcelain", "-z"],
        { cwd: ctx.cwd },
      );
      const mainWorktree = worktrees.stdout
        .split("\0", 1)[0]
        ?.replace(/^worktree /, "");

      if (worktrees.code !== 0 || !mainWorktree) {
        ctx.ui.notify(
          worktrees.stderr.trim() || "Not inside a Git repository",
          "error",
        );
        return;
      }

      const result = await pi.exec("git", ["-C", mainWorktree, "pull"]);
      const output = [result.stdout, result.stderr]
        .map((text) => text.trim())
        .filter(Boolean)
        .join("\n");

      ctx.ui.notify(
        output || `git pull exited with status ${result.code}`,
        result.code === 0 ? "info" : "error",
      );
    },
  });
}
