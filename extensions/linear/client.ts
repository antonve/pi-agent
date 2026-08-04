import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

export type LinearOperation = "query" | "mutation" | "subscription";

export interface LinearResultDetails {
  operation: LinearOperation;
  operationName?: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
}

interface LinearRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  signal?: AbortSignal;
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedErrorBody(body: string) {
  return truncateHead(body, {
    maxBytes: 8_000,
    maxLines: 100,
  }).content;
}

export function detectLinearOperation(query: string): LinearOperation {
  const source = query.replace(/^\s*#.*$/gm, "");
  const match = /(?:^|\n)\s*(query|mutation|subscription)\b/.exec(source);
  return (match?.[1] as LinearOperation | undefined) ?? "query";
}

export async function requestLinearGraphql({
  query,
  variables = {},
  operationName,
  signal,
  apiKey = process.env.LINEAR_API_KEY,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
}: LinearRequest) {
  const token = apiKey?.trim();
  if (!token)
    throw new Error(
      "Linear is not configured. Add LINEAR_API_KEY to ~/.config/agentbox/secrets.env and restart Herdr when no agents are running.",
    );
  if (!query.trim()) throw new Error("Linear GraphQL query must not be empty.");

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables,
      ...(operationName ? { operationName } : {}),
    }),
    signal,
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(
      `Linear GraphQL HTTP ${response.status}: ${boundedErrorBody(body)}`,
    );

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(
      `Linear GraphQL returned invalid JSON: ${boundedErrorBody(body)}`,
    );
  }

  const errors = record(payload)?.errors;
  if (Array.isArray(errors) && errors.length > 0)
    throw new Error(
      `Linear GraphQL returned errors:\n${boundedErrorBody(JSON.stringify(errors, null, 2))}`,
    );
  return payload;
}

export function formatLinearResult(
  payload: unknown,
  options: { query: string; operationName?: string },
) {
  const output = JSON.stringify(payload, null, 2);
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const details: LinearResultDetails = {
    operation: detectLinearOperation(options.query),
    operationName: options.operationName,
    truncated: truncation.truncated,
    totalBytes: truncation.totalBytes,
    totalLines: truncation.totalLines,
  };
  const notice = truncation.truncated
    ? `\n\n[Linear response truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Refine the selection set or paginate with pageInfo.endCursor.]`
    : "";
  return {
    content: [
      { type: "text" as const, text: `${truncation.content}${notice}` },
    ],
    details,
  };
}
