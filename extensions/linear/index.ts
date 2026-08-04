import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatLinearResult,
  requestLinearGraphql,
  type LinearResultDetails,
} from "./client.ts";

const RESOURCE_TYPES = [
  "teams",
  "users",
  "projects",
  "workflow_states",
  "issue_labels",
] as const;

const ISSUE_SUMMARY = `
  id
  identifier
  title
  priority
  url
  createdAt
  updatedAt
  dueDate
  team { id key name }
  state { id name type color }
  assignee { id name displayName email }
  project { id name url }
  labels { nodes { id name color } }
`;

const SEARCH_ISSUES = `
query PiLinearSearchIssues($term: String!, $teamId: String, $first: Int!, $after: String, $includeArchived: Boolean!) {
  searchIssues(term: $term, teamId: $teamId, first: $first, after: $after, includeArchived: $includeArchived) {
    totalCount
    nodes { ${ISSUE_SUMMARY} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const GET_ISSUE = `
query PiLinearGetIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_SUMMARY}
    description
    archivedAt
    parent { id identifier title url }
    children(first: 50) {
      nodes { id identifier title priority url state { id name type } assignee { id name } }
      pageInfo { hasNextPage endCursor }
    }
    comments(first: 50) {
      nodes { id body createdAt updatedAt user { id name displayName email } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const CREATE_ISSUE = `
mutation PiLinearCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { ${ISSUE_SUMMARY} description }
  }
}`;

const UPDATE_ISSUE = `
mutation PiLinearUpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { ${ISSUE_SUMMARY} description }
  }
}`;

const ADD_COMMENT = `
mutation PiLinearAddComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      createdAt
      updatedAt
      user { id name displayName email }
      issue { id identifier title url }
    }
  }
}`;

const LIST_QUERIES = {
  teams: `query PiLinearListTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes { id key name description }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  users: `query PiLinearListUsers($first: Int!, $after: String) {
    users(first: $first, after: $after) {
      nodes { id name displayName email active admin guest url }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  projects: `query PiLinearListProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after) {
      nodes { id name url createdAt updatedAt status { id name type color } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  workflow_states: `query PiLinearListWorkflowStates($first: Int!, $after: String) {
    workflowStates(first: $first, after: $after) {
      nodes { id name type color position team { id key name } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  issue_labels: `query PiLinearListIssueLabels($first: Int!, $after: String) {
    issueLabels(first: $first, after: $after) {
      nodes { id name color description team { id key name } parent { id name } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
} as const;

interface CreateIssueParams {
  team_id: string;
  title: string;
  description?: string;
  assignee_id?: string;
  state_id?: string;
  project_id?: string;
  priority?: number;
  label_ids?: string[];
  parent_id?: string;
  due_date?: string;
}

interface UpdateIssueParams {
  id: string;
  title?: string;
  description?: string;
  assignee_id?: string;
  state_id?: string;
  project_id?: string;
  priority?: number;
  label_ids?: string[];
  due_date?: string;
  clear_assignee?: boolean;
  clear_project?: boolean;
  clear_due_date?: boolean;
}

function definedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined),
  );
}

export function buildIssueCreateInput(params: CreateIssueParams) {
  return definedEntries({
    teamId: params.team_id,
    title: params.title,
    description: params.description,
    assigneeId: params.assignee_id,
    stateId: params.state_id,
    projectId: params.project_id,
    priority: params.priority,
    labelIds: params.label_ids,
    parentId: params.parent_id,
    dueDate: params.due_date,
  });
}

export function buildIssueUpdateInput(params: UpdateIssueParams) {
  return definedEntries({
    title: params.title,
    description: params.description,
    assigneeId: params.clear_assignee ? null : params.assignee_id,
    stateId: params.state_id,
    projectId: params.clear_project ? null : params.project_id,
    priority: params.priority,
    labelIds: params.label_ids,
    dueDate: params.clear_due_date ? null : params.due_date,
  });
}

async function executeLinear(
  query: string,
  variables: Record<string, unknown>,
  operationName: string,
  signal?: AbortSignal,
) {
  const payload = await requestLinearGraphql({
    query,
    variables,
    operationName,
    signal,
  });
  return formatLinearResult(payload, { query, operationName });
}

function resultText(result: AgentToolResult<unknown>) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function renderResult(
  result: AgentToolResult<unknown>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: { isError: boolean },
) {
  if (context.isError)
    return new Text(theme.fg("error", resultText(result)), 0, 0);
  if (options.isPartial)
    return new Text(theme.fg("warning", "Contacting Linear…"), 0, 0);
  const details = result.details as LinearResultDetails | undefined;
  let text = theme.fg(
    "success",
    `✓ Linear ${details?.operationName ?? details?.operation ?? "request"}`,
  );
  if (details?.truncated) text += theme.fg("warning", " (truncated)");
  if (options.expanded) text += `\n${theme.fg("dim", resultText(result))}`;
  return new Text(text, 0, 0);
}

function call(label: string, detail?: string) {
  return (args: Record<string, unknown>, theme: Theme) =>
    new Text(
      theme.fg("toolTitle", theme.bold(`linear ${label}`)) +
        (detail && typeof args[detail] === "string"
          ? theme.fg("accent", ` ${args[detail]}`)
          : ""),
      0,
      0,
    );
}

export default function linearExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "linear_search_issues",
    label: "Search Linear Issues",
    description:
      "Search Linear issues by text. Use this before raw linear_graphql for normal issue discovery.",
    promptSnippet: "Search Linear issues by text, optionally within a team",
    promptGuidelines: [
      "Use focused Linear issue tools for routine work; use linear_graphql only when they cannot perform the requested operation.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search terms" }),
      team_id: Type.Optional(Type.String()),
      first: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      after: Type.Optional(Type.String()),
      include_archived: Type.Optional(Type.Boolean()),
    }),
    async execute(_call, params, signal) {
      return executeLinear(
        SEARCH_ISSUES,
        {
          term: params.query,
          teamId: params.team_id,
          first: params.first ?? 25,
          after: params.after,
          includeArchived: params.include_archived ?? false,
        },
        "PiLinearSearchIssues",
        signal,
      );
    },
    renderCall: call("search", "query"),
    renderResult,
  });

  pi.registerTool({
    name: "linear_get_issue",
    label: "Get Linear Issue",
    description:
      "Read one Linear issue, including its description, relations, labels, and first 50 comments.",
    promptSnippet: "Read a Linear issue by UUID or identifier such as ENG-123",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_call, params, signal) {
      return executeLinear(
        GET_ISSUE,
        { id: params.id },
        "PiLinearGetIssue",
        signal,
      );
    },
    renderCall: call("get", "id"),
    renderResult,
  });

  pi.registerTool({
    name: "linear_list_resources",
    label: "List Linear Resources",
    description:
      "List teams, users, projects, workflow states, or issue labels and their IDs for subsequent issue operations.",
    promptSnippet:
      "Resolve Linear team, user, project, state, and label names to IDs",
    parameters: Type.Object({
      resource: StringEnum(RESOURCE_TYPES),
      first: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      after: Type.Optional(Type.String()),
    }),
    async execute(_call, params, signal) {
      const operationName = `PiLinearList${params.resource
        .split("_")
        .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
        .join("")}`;
      return executeLinear(
        LIST_QUERIES[params.resource],
        { first: params.first ?? 50, after: params.after },
        operationName,
        signal,
      );
    },
    renderCall: call("list", "resource"),
    renderResult,
  });

  pi.registerTool({
    name: "linear_create_issue",
    label: "Create Linear Issue",
    description:
      "Create a Linear issue. Resolve team and optional relation IDs with linear_list_resources first.",
    promptSnippet:
      "Create a Linear issue with optional state, assignee, project, labels, priority, and due date",
    parameters: Type.Object({
      team_id: Type.String(),
      title: Type.String(),
      description: Type.Optional(Type.String()),
      assignee_id: Type.Optional(Type.String()),
      state_id: Type.Optional(Type.String()),
      project_id: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
      label_ids: Type.Optional(Type.Array(Type.String())),
      parent_id: Type.Optional(Type.String()),
      due_date: Type.Optional(
        Type.String({ description: "ISO date: YYYY-MM-DD" }),
      ),
    }),
    async execute(_call, params, signal) {
      return executeLinear(
        CREATE_ISSUE,
        { input: buildIssueCreateInput(params) },
        "PiLinearCreateIssue",
        signal,
      );
    },
    renderCall: call("create", "title"),
    renderResult,
  });

  pi.registerTool({
    name: "linear_update_issue",
    label: "Update Linear Issue",
    description:
      "Update common Linear issue fields. Use explicit clear_* flags to remove assignee, project, or due date.",
    promptSnippet: "Update a Linear issue's common fields",
    parameters: Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      assignee_id: Type.Optional(Type.String()),
      state_id: Type.Optional(Type.String()),
      project_id: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
      label_ids: Type.Optional(Type.Array(Type.String())),
      due_date: Type.Optional(
        Type.String({ description: "ISO date: YYYY-MM-DD" }),
      ),
      clear_assignee: Type.Optional(Type.Boolean()),
      clear_project: Type.Optional(Type.Boolean()),
      clear_due_date: Type.Optional(Type.Boolean()),
    }),
    async execute(_call, params, signal) {
      const input = buildIssueUpdateInput(params);
      if (Object.keys(input).length === 0)
        throw new Error(
          "linear_update_issue requires at least one changed field.",
        );
      return executeLinear(
        UPDATE_ISSUE,
        { id: params.id, input },
        "PiLinearUpdateIssue",
        signal,
      );
    },
    renderCall: call("update", "id"),
    renderResult,
  });

  pi.registerTool({
    name: "linear_add_comment",
    label: "Comment on Linear Issue",
    description: "Add a Markdown comment to a Linear issue.",
    promptSnippet: "Add a Markdown comment to a Linear issue",
    parameters: Type.Object({
      issue_id: Type.String(),
      body: Type.String(),
    }),
    async execute(_call, params, signal) {
      return executeLinear(
        ADD_COMMENT,
        { input: { issueId: params.issue_id, body: params.body } },
        "PiLinearAddComment",
        signal,
      );
    },
    renderCall: call("comment", "issue_id"),
    renderResult,
  });

  pi.registerTool({
    name: "linear_graphql",
    label: "Linear GraphQL Fallback",
    description:
      "Execute an arbitrary authenticated Linear GraphQL query or mutation. This is an unrestricted fallback for operations the focused Linear tools cannot perform. Output is limited to 2,000 lines or 50KB; paginate or narrow selection sets when truncated.",
    promptSnippet:
      "Fallback to arbitrary Linear GraphQL when focused Linear tools are insufficient",
    promptGuidelines: [
      "Use linear_graphql only as a fallback after focused Linear tools prove insufficient; use variables rather than interpolating user text into GraphQL.",
      "Never archive, delete, or otherwise destructively mutate Linear data unless the user explicitly requests it.",
    ],
    parameters: Type.Object({
      query: Type.String(),
      variables: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      operation_name: Type.Optional(Type.String()),
    }),
    async execute(_call, params, signal) {
      const payload = await requestLinearGraphql({
        query: params.query,
        variables: params.variables,
        operationName: params.operation_name,
        signal,
      });
      return formatLinearResult(payload, {
        query: params.query,
        operationName: params.operation_name,
      });
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("linear graphql")) +
          (args.operation_name
            ? theme.fg("accent", ` ${args.operation_name}`)
            : ""),
        0,
        0,
      );
    },
    renderResult,
  });
}
