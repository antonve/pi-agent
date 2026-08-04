import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detectLinearOperation,
  formatLinearResult,
  requestLinearGraphql,
} from "./client.ts";
import linearExtension, {
  buildIssueCreateInput,
  buildIssueUpdateInput,
} from "./index.ts";

test("registers focused Linear tools plus a GraphQL fallback", () => {
  const tools = new Map<string, { description: string }>();
  const api = {
    registerTool(tool: { name: string; description: string }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  linearExtension(api);

  assert.deepEqual(
    [...tools.keys()],
    [
      "linear_search_issues",
      "linear_get_issue",
      "linear_list_resources",
      "linear_create_issue",
      "linear_update_issue",
      "linear_add_comment",
      "linear_graphql",
    ],
  );
  assert.match(tools.get("linear_graphql")!.description, /fallback/i);
});

test("maps ergonomic issue fields to Linear GraphQL inputs", () => {
  assert.deepEqual(
    buildIssueCreateInput({
      team_id: "team-1",
      title: "Investigate",
      assignee_id: "user-1",
      label_ids: ["label-1"],
      priority: 2,
    }),
    {
      teamId: "team-1",
      title: "Investigate",
      assigneeId: "user-1",
      labelIds: ["label-1"],
      priority: 2,
    },
  );
  assert.deepEqual(
    buildIssueUpdateInput({
      id: "ENG-123",
      state_id: "state-1",
      clear_assignee: true,
      clear_due_date: true,
    }),
    { stateId: "state-1", assigneeId: null, dueDate: null },
  );
});

test("sends the personal API key and GraphQL variables without interpolation", async () => {
  const controller = new AbortController();
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(input, "https://linear.test/graphql");
    assert.equal(new Headers(init?.headers).get("Authorization"), "lin_test");
    assert.equal(init?.signal, controller.signal);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ data: { viewer: { id: "user-1" } } }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const payload = await requestLinearGraphql({
    query: "query Viewer($name: String!) { viewer { id } }",
    variables: { name: "quoted user input" },
    operationName: "Viewer",
    signal: controller.signal,
    apiKey: "lin_test",
    endpoint: "https://linear.test/graphql",
    fetchImpl,
  });

  assert.deepEqual(payload, { data: { viewer: { id: "user-1" } } });
  assert.deepEqual(requestBody, {
    query: "query Viewer($name: String!) { viewer { id } }",
    variables: { name: "quoted user input" },
    operationName: "Viewer",
  });
});

test("reports GraphQL errors as failed tool execution", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({ errors: [{ message: "Unknown Linear field" }] }),
      { status: 200 },
    );

  await assert.rejects(
    requestLinearGraphql({
      query: "query Broken { missing }",
      apiKey: "lin_test",
      fetchImpl,
    }),
    /Unknown Linear field/,
  );
  await assert.rejects(
    requestLinearGraphql({
      query: "query Viewer { viewer { id } }",
      apiKey: "",
    }),
    /LINEAR_API_KEY/,
  );
});

test("detects mutations and truncates oversized responses", () => {
  assert.equal(
    detectLinearOperation(
      "# explanation\nmutation Update { issueUpdate { success } }",
    ),
    "mutation",
  );
  assert.equal(
    detectLinearOperation(
      "fragment Fields on Issue { id }\nmutation Update { issueUpdate { success } }",
    ),
    "mutation",
  );
  const result = formatLinearResult(
    { data: { value: "x".repeat(60_000) } },
    { query: "query Large { large }", operationName: "Large" },
  );
  assert.equal(result.details.truncated, true);
  assert.match(result.content[0]!.text, /response truncated/i);
});
