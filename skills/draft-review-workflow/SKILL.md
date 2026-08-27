---
name: draft-review-workflow
description: Publish, revise, or publicly share Draft HTML or Markdown documents. Use when an agent needs to put a document in Draft for review, work through its durable human-annotation loop, recover an interrupted review, or publish a pinned Draft HTML revision through an unlisted GitHub Gist and return an HTMLPreview link.
---

# Work with Draft documents

Use the `draft` CLI as the durable handoff between the agent and reviewer.

## Start or update a document

1. Verify `command -v draft` and `draft auth status`. A standalone install
   reports that authentication is disabled and needs no login. If another
   deployment reports that authentication is absent, run `draft auth login`
   and let the user complete the device flow.
2. Keep an editable source file. Prefer a self-contained HTML artifact unless
   the user requests Markdown or an existing artifact fixes the format.
3. Choose a stable slug. Before updating an existing slug, identify its current
   version and fetch that revision when the local source is not known to match.
4. Create a new document and capture its JSON result:

   ```sh
   draft publish <file> --slug <slug> --title <title> \
     --client-label agent-review --json
   ```

5. Update a document only from the exact revision used as the editing base:

   ```sh
   draft publish <file> --slug <slug> --base-version <version> \
     --client-label agent-review --json
   ```

   Never retry a `stale_base` failure with the newly reported version. Fetch
   that revision with `draft get <slug> --version <version>`, reconcile it with
   the edited source, and publish the reconciled result from that version.
6. Give the user the pinned URL returned by `draft publish`. Ask them to open
   Review; while the panel is open, they can hover and click elements or select
   text to annotate, add general notes, and choose **Send feedback to agent**.

## Receive and apply feedback

1. Before blocking, tell the user that Draft is waiting for their submitted
   review. Then use the CLI's bounded long-poll loop:

   ```sh
   draft feedback wait --slug <slug> --json
   ```

   Let the process wait in a resumable execution session. Do not replace it
   with rapid list polling. Its waiting notice goes to stderr and the complete
   review JSON goes to stdout.
2. Record the review `id`, `document_version`, `latest_version`, `content_hash`,
   comments, and anchors. Reading marks the review observed but does not consume
   it; it remains pending until resolution.
3. Apply every comment against `document_version`, not an unpinned latest view.
   Use the local source only when it is known to represent that exact content;
   otherwise recover it with:

   ```sh
   draft get <slug> --version <document-version> > <source-file>
   ```

   Use each anchor's quote, offsets, rendered path, and surrounding context as
   redundant evidence. Treat the quoted text and the comment's intent as
   authoritative when DOM structure has shifted.
4. If `latest_version` advanced beyond the reviewed version, reconcile the
   latest revision before publishing. Do not overwrite concurrent work.
5. Validate the edited artifact, publish it from its exact base version, and
   capture the returned revision number. Resolve only after the publish and any
   requested implementation work have succeeded:

   ```sh
   draft feedback resolve <review-id> \
     --disposition addressed \
     --result-version <published-version> \
     --message "Applied in version <published-version>" --json
   ```

6. Use `declined` with a concise reason when intentionally not applying the
   batch. Use `needs_user` with the precise open question when progress requires
   another human decision. Do not delete, ignore, or falsely resolve feedback.
7. Return the new pinned URL and outcome. If the user starts another review
   after seeing the outcome, repeat the workflow; Draft creates a new batch only
   after the prior one is resolved.

## Publish a pinned HTML revision publicly

Use this mode only when the user explicitly asks to make a Draft document
publicly accessible. It reads the requested pinned revision without changing
Draft. A secret GitHub Gist is unlisted rather than private: anyone with the
resulting URL can access it.

1. Parse the Draft URL into its slug and positive `version` query parameter.
   Require a pinned `.html` revision; do not substitute the latest version.
2. Verify `draft auth status` and `gh auth status`. The GitHub token must have
   the `gist` scope.
3. Set task-specific shell variables and use a stable filename:

   ```sh
   public_slug=<slug>
   public_version=<version>
   public_filename="${public_slug}.html"
   public_description="${public_slug} — Draft version ${public_version}"
   ```

4. If no prior Gist was supplied or established in the conversation, create an
   unlisted Gist. Do not pass `--public`, which would list it publicly:

   ```sh
   public_gist_url="$(
     draft get "$public_slug" --version "$public_version" |
       gh gist create --filename "$public_filename" \
         --desc "$public_description" -
   )"
   public_gist_id="${public_gist_url##*/}"
   ```

5. To replace an established one-file HTML Gist, identify its current HTML
   filename, then update and normalize it to the stable filename in one request:

   ```sh
   public_gist_id=<gist-id>
   public_old_filename="$(
     gh api "gists/$public_gist_id" |
       jq -r '[.files[] | select(.filename | endswith(".html"))] |
         if length == 1 then .[0].filename
         else error("expected exactly one HTML file") end'
   )"

   updated_gist_id="$(
     draft get "$public_slug" --version "$public_version" |
       jq -Rs \
         --arg old_filename "$public_old_filename" \
         --arg filename "$public_filename" \
         --arg description "$public_description" \
         '{description:$description,files:{
           ($old_filename):{filename:$filename,content:.}
         }}' |
       gh api --method PATCH "gists/$public_gist_id" --input - --jq .id
   )"
   ```

   Stop if the Gist has zero or multiple HTML files rather than guessing which
   file to replace. Do not create a second Gist merely because its filename
   contains an older version number.
6. Read the post-mutation `raw_url` and prefix it with HTMLPreview. The returned
   raw URL is revision-specific, so always derive a fresh preview URL after an
   update:

   ```sh
   public_raw_url="$(
     gh api "gists/$public_gist_id" |
       jq -r --arg filename "$public_filename" '.files[$filename].raw_url'
   )"
   printf 'https://htmlpreview.github.io/?%s\n' "$public_raw_url"
   ```

7. Return only the clickable HTMLPreview URL. Do not include the Gist source
   URL, hashes, byte comparisons, content audits, or browser-render checks
   unless the user explicitly asks for them. Successful Gist creation or update
   and extraction of its `raw_url` are sufficient.

## Recover safely

- Resume by listing durable pending work, then reopen the selected batch:

  ```sh
  draft feedback --slug <slug> --json
  draft feedback get <review-id> --json
  ```

- After an ambiguous publish response, inspect the current version with
  `draft list --json`, fetch it, and compare its content with the edited source.
  Reuse a proven matching version; never publish a duplicate merely to recover.
- After an ambiguous resolve response, run `draft feedback get <review-id>
  --json`. If it is already resolved, report that outcome instead of retrying.
- Keep a batch unresolved across crashes, timeouts, failed validation, and
  incomplete implementation. Observation is safe and repeatable; resolution
  is the deliberate acknowledgement.
- Process all pending batches returned by `draft feedback --json` before
  waiting for new ones.
