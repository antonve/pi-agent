import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { loadSummaryConfig } from "../summaries/src/config.ts";
import { resolveSummaryPolicy } from "../shared/model-policy.ts";

const SINGLE_REPORT_SKIP_LENGTH = 4_000;
const MAX_REPORT_LENGTH = 12_000;

export interface CompiledFleetReport {
  summary: string;
  changes: string[];
  verification: string[];
  risks: string[];
  decisions: string[];
  artifacts: string[];
}

export function shouldCompileReports(reports: readonly string[]) {
  if (reports.length >= 2) return true;
  return reports.length === 1 && reports[0]!.length > SINGLE_REPORT_SKIP_LENGTH;
}

export async function compileFleetReports(options: {
  modelRegistry: ModelRegistry;
  reports: readonly string[];
  signal?: AbortSignal;
}): Promise<CompiledFleetReport | undefined> {
  if (!shouldCompileReports(options.reports)) return undefined;
  const config = resolveSummaryPolicy(loadSummaryConfig());
  const model = options.modelRegistry.find(config.provider, config.model);
  if (!model)
    throw new Error(
      `Report model is unavailable: ${config.provider}/${config.model}`,
    );
  const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const reports = options.reports.map(
    (report, index) =>
      `REPORT ${index + 1}\n${report.slice(0, MAX_REPORT_LENGTH)}`,
  );
  const response = await completeSimple(
    model,
    {
      systemPrompt:
        "Compile normalized worker reports into one concise task outcome. Deduplicate facts. Preserve disagreements and uncertainty. Return exactly one JSON object with summary (string), changes, verification, risks, decisions, and artifacts (arrays of strings).",
      messages: [
        {
          role: "user",
          content: reports.join("\n\n---\n\n"),
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      env: auth.env,
      headers: auth.headers,
      maxTokens: 1_500,
      maxRetries: 1,
      timeoutMs: 40_000,
      signal: options.signal,
      reasoning: config.reasoning,
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted")
    throw new Error(response.errorMessage ?? "Report compilation failed.");
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return parseCompiledFleetReport(text);
}

export function parseCompiledFleetReport(text: string): CompiledFleetReport {
  const candidates = [text.trim()];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof value.summary !== "string" || !value.summary.trim()) continue;
      const arrays = [
        "changes",
        "verification",
        "risks",
        "decisions",
        "artifacts",
      ] as const;
      if (
        arrays.some(
          (key) =>
            !Array.isArray(value[key]) ||
            !(value[key] as unknown[]).every(
              (item) => typeof item === "string",
            ),
        )
      )
        continue;
      return {
        summary: value.summary.trim().slice(0, 4_000),
        changes: value.changes as string[],
        verification: value.verification as string[],
        risks: value.risks as string[],
        decisions: value.decisions as string[],
        artifacts: value.artifacts as string[],
      };
    } catch {
      // Try another bounded JSON candidate.
    }
  }
  throw new Error("Report compiler returned invalid JSON.");
}
