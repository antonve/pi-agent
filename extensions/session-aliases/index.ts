import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("pull", {
    description: "Pull the current Git repository",
    handler: async () => {
      pi.sendUserMessage("/skill:pull");
    },
  });
}
