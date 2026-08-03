export type CalmToolOutputMode = "hidden" | "compact";
export type ToolRenderPart = "call" | "result";

/**
 * Keep failures and Ctrl+O-expanded details visible. In the normal collapsed
 * view, hidden tools occupy no rows while compact tools retain only their call.
 */
export function shouldRenderToolPart(
  mode: CalmToolOutputMode,
  part: ToolRenderPart,
  expanded: boolean,
  isError: boolean,
) {
  if (expanded || isError) return true;
  return mode === "compact" && part === "call";
}
