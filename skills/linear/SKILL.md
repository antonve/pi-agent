---
name: linear
description: Read and write Linear issues, comments, teams, users, projects, workflow states, labels, and other workspace data. Use whenever a task involves Linear tickets or Linear workspace administration.
---

# Linear

Use the focused Linear tools for routine work:

1. `linear_search_issues` to find issues.
2. `linear_get_issue` to read the complete issue and recent comments.
3. `linear_list_resources` to resolve human names to IDs.
4. `linear_create_issue`, `linear_update_issue`, and `linear_add_comment` for normal writes.
5. `linear_graphql` only when the focused tools cannot perform the operation.

## Working rules

- Prefer issue identifiers such as `ENG-123` when reading or updating known issues.
- Resolve team, user, project, workflow-state, and label IDs instead of guessing them.
- Use Markdown in issue descriptions and comments.
- Linear priorities are `0` none, `1` urgent, `2` high, `3` normal, and `4` low.
- Use `YYYY-MM-DD` for due dates.
- Use pagination when `pageInfo.hasNextPage` is true by passing `pageInfo.endCursor` as `after`.
- Before a write, confirm that the selected workspace object and requested change match the user's intent.
- Never archive, delete, or perform another destructive mutation unless the user explicitly requests it.
- Never expose `LINEAR_API_KEY` in tool arguments, output, logs, or files.

## GraphQL fallback

Linear's endpoint supports introspection. When a focused tool is insufficient:

1. Use `linear_graphql` with a small introspection query to discover the relevant field or input type.
2. Use named operations and GraphQL variables. Do not interpolate user-provided text into the query string.
3. Keep selection sets narrow and paginate connections to avoid truncation.
4. Read the target object first when a mutation depends on current state.
5. Verify mutation payload `success` and return the changed object's identifier or URL.

Example schema lookup:

```graphql
query PiLinearInspectType($name: String!) {
  __type(name: $name) {
    name
    kind
    inputFields {
      name
      type {
        kind
        name
        ofType { kind name }
      }
    }
  }
}
```

Variables:

```json
{ "name": "IssueUpdateInput" }
```

Example fallback mutation shape:

```graphql
mutation PiLinearFallback($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier title url }
  }
}
```
