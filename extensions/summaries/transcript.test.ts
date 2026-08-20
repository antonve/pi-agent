import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  countVisibleRunCharacters,
  createRunBoundary,
  getRunEntries,
  hasMinimumRecapDuration,
  hasMinimumVisibleRecapContent,
  hasMultipleUserTurns,
  RECAP_MIN_RUN_DURATION_MS,
  RECAP_MIN_VISIBLE_CHARACTERS,
  serializeRunTranscript,
  TRANSCRIPT_MAX_BYTES,
} from "./src/transcript.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(
  id: string,
  message: Extract<SessionEntry, { type: "message" }>["message"],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

test("run boundaries replace stale starts and settle exactly once", () => {
  const boundary = createRunBoundary();
  boundary.begin("before-run", 100);
  boundary.begin("new-top-level-run", 200);

  assert.deepEqual(boundary.settle(), {
    baselineLeafId: "new-top-level-run",
    startedAt: 200,
  });
  assert.equal(boundary.settle(), undefined);
});

test("recaps require a run lasting at least 60 seconds", () => {
  const run = { baselineLeafId: "before-run", startedAt: 1_000 };

  assert.equal(
    hasMinimumRecapDuration(run, 1_000 + RECAP_MIN_RUN_DURATION_MS - 1),
    false,
  );
  assert.equal(
    hasMinimumRecapDuration(run, 1_000 + RECAP_MIN_RUN_DURATION_MS),
    true,
  );
  assert.equal(
    hasMinimumRecapDuration(run, 1_000 + RECAP_MIN_RUN_DURATION_MS + 1),
    true,
  );
});

test("visible character counts include rendered text and tool output only", () => {
  const visibleParts = [
    "user",
    "reply",
    "bash",
    "output",
    "pwd",
    "/tmp",
    "notice",
  ];
  const entries: SessionEntry[] = [
    entry("user", {
      role: "user",
      content: [
        { type: "text", text: visibleParts[0]! },
        { type: "image", data: "hidden-image-data", mimeType: "image/png" },
      ],
      timestamp: 0,
    }),
    entry("assistant", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden thinking".repeat(100) },
        {
          type: "toolCall",
          id: "call-1",
          name: visibleParts[2]!,
          arguments: { hidden: "argument".repeat(100) },
        },
        { type: "text", text: visibleParts[1]! },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    }),
    entry("result", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: visibleParts[3]! }],
      isError: false,
      timestamp: 2,
    }),
    entry("shell", {
      role: "bashExecution",
      command: visibleParts[4]!,
      output: visibleParts[5]!,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 3,
    }),
    entry("custom-visible", {
      role: "custom",
      customType: "notice",
      content: visibleParts[6]!,
      display: true,
      timestamp: 4,
    }),
    entry("custom-hidden", {
      role: "custom",
      customType: "notice",
      content: "hidden custom message".repeat(100),
      display: false,
      timestamp: 5,
    }),
    entry("recap", {
      role: "custom",
      customType: "summary-recap",
      content: "old recap".repeat(100),
      display: true,
      timestamp: 6,
    }),
  ];

  assert.equal(
    countVisibleRunCharacters(entries),
    visibleParts.reduce((total, part) => total + [...part].length, 0),
  );
});

test("recaps require at least 1,000 visible characters", () => {
  const entriesWith = (count: number) => [
    entry("user", {
      role: "user" as const,
      content: "😀".repeat(count),
      timestamp: 0,
    }),
  ];

  assert.equal(
    hasMinimumVisibleRecapContent(
      entriesWith(RECAP_MIN_VISIBLE_CHARACTERS - 1),
    ),
    false,
  );
  assert.equal(
    hasMinimumVisibleRecapContent(entriesWith(RECAP_MIN_VISIBLE_CHARACTERS)),
    true,
  );
});

test("recaps require more than one user turn on the branch", () => {
  const first = entry("first", {
    role: "user",
    content: "first request",
    timestamp: 0,
  });
  const second = entry("second", {
    role: "user",
    content: "follow-up request",
    timestamp: 1,
  });

  assert.equal(hasMultipleUserTurns([]), false);
  assert.equal(hasMultipleUserTurns([first]), false);
  assert.equal(hasMultipleUserTurns([first, second]), true);
});

test("run slicing starts after the before_agent_start leaf", () => {
  const entries = [
    entry("old", { role: "user", content: "old", timestamp: 0 }),
    entry("new", { role: "user", content: "new", timestamp: 1 }),
  ];
  assert.deepEqual(
    getRunEntries(entries, "old").map((item) => item.id),
    ["new"],
  );
  assert.deepEqual(getRunEntries(entries, "missing"), []);
});

test("transcript omits thinking, images, and recap entries while redacting tool data", () => {
  const entries: SessionEntry[] = [
    entry("user", {
      role: "user",
      content: [
        { type: "text", text: "Update the client" },
        { type: "image", data: "base64-image-bytes", mimeType: "image/png" },
      ],
      timestamp: 0,
    }),
    entry("assistant", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: {
            command:
              "curl -H 'Authorization: Bearer very-secret-token' https://example.test",
            apiKey: "sk-super-secret-value",
            payload: "x".repeat(10_000),
          },
        },
        { type: "text", text: "Updated the client." },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    }),
    entry("result", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "token=another-secret\nfinished" }],
      isError: false,
      timestamp: 2,
    }),
    {
      type: "custom",
      id: "old-recap",
      parentId: "result",
      timestamp: new Date(0).toISOString(),
      customType: "summary-recap",
      data: { recap: "old recap" },
    },
  ];

  const transcript = serializeRunTranscript(entries);
  assert.match(transcript, /Update the client/);
  assert.match(transcript, /TOOL CALL bash/);
  assert.match(transcript, /Updated the client/);
  assert.doesNotMatch(transcript, /hidden chain of thought/);
  assert.doesNotMatch(transcript, /base64-image-bytes/);
  assert.doesNotMatch(transcript, /very-secret-token/);
  assert.doesNotMatch(transcript, /another-secret/);
  assert.doesNotMatch(transcript, /old recap/);
  assert.match(transcript, /\[REDACTED\]/);
  assert.match(transcript, /tool arguments capped/);
});

test("transcript enforces per-result and total byte caps", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    entry(`result-${index}`, {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "bash",
      content: [{ type: "text", text: `${index}:${"x".repeat(10_000)}` }],
      isError: false,
      timestamp: index,
    }),
  );

  const transcript = serializeRunTranscript(entries);
  assert.ok(Buffer.byteLength(transcript, "utf8") <= TRANSCRIPT_MAX_BYTES);
  assert.match(transcript, /transcript capped/);
  assert.match(transcript, /tool result capped/);
});
