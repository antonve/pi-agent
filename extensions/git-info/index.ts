import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const LAZY_START_DELAY_MS = 250;

/** Load the Effect-based git dashboard after Pi has finished becoming interactive. */
export default function gitInfoLoader(pi: ExtensionAPI) {
  let activeContext: ExtensionContext | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let loading: Promise<void> | undefined;

  const load = () => {
    if (loading) return loading;
    loading = import("./implementation.ts")
      .then(({ default: registerGitInfo }) => {
        registerGitInfo(pi, activeContext);
      })
      .catch((error) => {
        loading = undefined;
        if (activeContext?.hasUI) {
          activeContext.ui.notify(
            `Git info failed to load: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      });
    return loading;
  };

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    loadTimer = setTimeout(() => void load(), LAZY_START_DELAY_MS);
    loadTimer.unref?.();
  });

  pi.on("session_shutdown", () => {
    activeContext = undefined;
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = undefined;
  });
}
