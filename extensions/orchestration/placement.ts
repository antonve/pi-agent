import type {
  Isolation,
  Placement,
  ResolvedPlacement,
  TaskKind,
} from "./domain.ts";

const READ_ONLY =
  /\b(review|research|analy[sz]e|inspect|investigate|explain|summari[sz]e|compare|audit|diagnos(?:e|is)|read[- ]only)\b/i;
const MUTATING =
  /\b(implement|fix|refactor|edit|write|change|modify|create|delete|migrate|upgrade|add feature|commit)\b/i;

export function resolveIsolation(
  requested: Isolation,
  prompt: string,
): Exclude<Isolation, "auto"> {
  if (requested !== "auto") return requested;
  if (READ_ONLY.test(prompt) && !MUTATING.test(prompt)) return "shared";
  return "treehouse";
}

export function resolvePlacement(options: {
  requested: Placement;
  kind: TaskKind;
  isolated?: boolean;
  expectedLong?: boolean;
}): ResolvedPlacement {
  if (options.requested !== "auto") return options.requested;
  if (options.isolated || options.expectedLong || options.kind !== "background")
    return "tab";
  return "tab";
}
