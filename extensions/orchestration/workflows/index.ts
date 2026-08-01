import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  Harness,
  Isolation,
  LeaseRecord,
  ReasoningLevel,
  TaskRecord,
} from "../domain.ts";
import { HARNESSES, ISOLATIONS, REASONING_LEVELS } from "../domain.ts";
import type { OrchestrationManager } from "../manager.ts";
import { stateDirectory } from "../registry.ts";
import { RunController } from "./controller.ts";
import { extractMeta, prepareWorkflowScript } from "./meta.ts";
import {
  runWorkflowSandbox,
  type SandboxAgentOptions,
  type SandboxAgentResult,
} from "./sandbox.ts";

interface WorkflowRun {
  runId: string;
  name?: string;
  status: "running" | "completed" | "failed" | "aborted";
  background: boolean;
  phase?: string;
  startedAt: number;
  finishedAt?: number;
  children: string[];
  sharedChildren?: string[];
  sharedLease?: LeaseRecord;
  result?: unknown;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateSchema(value: unknown, schema: unknown): boolean {
  if (!isRecord(schema)) return true;
  if (Array.isArray(schema.enum))
    return schema.enum.some((item) => Object.is(item, value));
  if (schema.type === "object") {
    if (!isRecord(value)) return false;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((key) => typeof key === "string" && !(key in value))
    )
      return false;
    if (isRecord(schema.properties))
      for (const [key, child] of Object.entries(schema.properties))
        if (key in value && !validateSchema(value[key], child)) return false;
    return true;
  }
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      (!schema.items ||
        value.every((item) => validateSchema(item, schema.items)))
    );
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "null") return value === null;
  return true;
}

export function extractFinalJson(output: string, schema: unknown) {
  const candidates: string[] = [];
  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    if (match[1]) candidates.push(match[1].trim());
  const lines = output.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (line.startsWith("{") || line.startsWith("[")) candidates.push(line);
  }
  const first = output.lastIndexOf("\n{");
  if (first >= 0) candidates.push(output.slice(first + 1).trim());
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (validateSchema(value, schema)) return value;
    } catch {
      /* try another final candidate */
    }
  }
  throw new Error(
    "Child did not end with one JSON value matching the supplied schema.",
  );
}

export function registerWorkflow(
  pi: ExtensionAPI,
  manager: OrchestrationManager,
  describe: (task: TaskRecord) => string,
) {
  const active = new Map<string, WorkflowRun>();
  const runRoot = join(stateDirectory(), "workflows");

  async function persist(run: WorkflowRun, script?: string, args?: string) {
    const directory = join(runRoot, run.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "workflow.json"),
      `${JSON.stringify(run, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (script !== undefined)
      await writeFile(join(directory, "script.js"), script, { mode: 0o600 });
    if (args !== undefined)
      await writeFile(join(directory, "args.json"), args, { mode: 0o600 });
  }

  pi.registerTool({
    name: "workflow",
    label: "Herdr Workflow",
    description:
      "Run an explicitly requested inline JavaScript workflow. phase(), agent(), and parallel() delegate every child to the shared visible Herdr/Treehouse subagent manager. Concurrency is capped at four.",
    parameters: Type.Object({
      script: Type.String(),
      args: Type.Optional(Type.String()),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(_call, params, signal, onUpdate, ctx) {
      if (!pi.getActiveTools().includes("workflow"))
        throw new Error(
          "The workflow tool requires explicit workflow/ultracode intent.",
        );
      manager.assertAvailable();
      const prepared = prepareWorkflowScript(params.script);
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const run: WorkflowRun = {
        runId,
        name: prepared.meta.name,
        status: "running",
        background: params.background === true,
        startedAt: Date.now(),
        children: [],
      };
      active.set(runId, run);
      await persist(run, params.script, params.args);
      let args: unknown = params.args;
      if (params.args) {
        try {
          args = JSON.parse(params.args);
        } catch {
          /* keep string */
        }
      }
      const controller = new RunController(
        run.background ? undefined : signal,
        4,
      );

      const invoke = async (
        prompt: string,
        options: SandboxAgentOptions,
        invocationSignal: AbortSignal,
      ): Promise<SandboxAgentResult> => {
        const harness =
          typeof options.harness === "string" &&
          (HARNESSES as readonly string[]).includes(options.harness)
            ? (options.harness as Harness)
            : "pi";
        const isolation =
          typeof options.isolation === "string" &&
          (ISOLATIONS as readonly string[]).includes(options.isolation)
            ? (options.isolation as Isolation)
            : "auto";
        const effort =
          typeof options.effort === "string" &&
          (REASONING_LEVELS as readonly string[]).includes(options.effort)
            ? (options.effort as ReasoningLevel)
            : undefined;
        const model =
          typeof options.model === "string"
            ? typeof options.provider === "string"
              ? `${options.provider}/${options.model}`
              : options.model
            : undefined;
        const label =
          typeof options.label === "string"
            ? options.label
            : `${runId}-agent-${run.children.length + 1}`;
        const schema = options.schema;
        const useSharedLease = options.sharedLease === true;
        if (useSharedLease && !run.sharedLease) {
          run.sharedLease = await manager.treehouse.acquire(
            ctx.cwd,
            `${runId}-shared-workflow`,
          );
          run.sharedChildren = [];
          await persist(run);
        }
        const structuredInstruction =
          schema === undefined
            ? ""
            : `\n\nStructured result requirement: end your response with exactly one JSON value matching this JSON Schema, with no text after it:\n${JSON.stringify(schema)}`;
        const task = await manager.spawnAgent({
          prompt: `${prompt}${structuredInstruction}`,
          label,
          harness,
          cwd: useSharedLease ? run.sharedLease!.path : ctx.cwd,
          model,
          reasoning: effort,
          isolation: useSharedLease ? "shared" : isolation,
          placement: "tab",
          parentSession: ctx.sessionManager.getSessionId(),
          parentModel: ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : undefined,
          parentReasoning: pi.getThinkingLevel() as ReasoningLevel,
          kind: "workflow-child",
        });
        run.children.push(task.id);
        if (useSharedLease) {
          run.sharedChildren!.push(task.id);
          await manager.registry.update(task.id, {
            lease: {
              ...run.sharedLease!,
              returnState: run.sharedChildren!.length === 1 ? "held" : "shared",
            },
            autoCloseCancelled: true,
            autoCloseAt: undefined,
          });
        }
        await persist(run);
        await manager.wait([task.id], invocationSignal);
        let settled = await manager.registry.get(task.id);
        if (!settled || settled.status !== "done")
          return {
            ok: false,
            output: "",
            error:
              settled?.error ??
              `Child settled as ${settled?.status ?? "unknown"}`,
          };
        let output = await manager.output(task.id);
        if (schema === undefined) return { ok: true, output };
        try {
          return {
            ok: true,
            output,
            structured: extractFinalJson(output, schema),
          };
        } catch {
          await manager.send(
            task.id,
            `Your prior response did not satisfy the requested structured protocol. End this correction response with exactly one JSON value matching this schema and no text after it:\n${JSON.stringify(schema)}`,
          );
          await manager.wait([task.id], invocationSignal);
          settled = await manager.registry.get(task.id);
          output = await manager.output(task.id);
          if (!settled || settled.status !== "done")
            return {
              ok: false,
              output,
              error: "Structured correction failed.",
            };
          try {
            return {
              ok: true,
              output,
              structured: extractFinalJson(output, schema),
            };
          } catch (error) {
            return {
              ok: false,
              output,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      };

      const execute = async () => {
        try {
          run.result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: ctx.cwd,
            signal: controller.signal,
            onPhase(title) {
              run.phase = title;
              void persist(run);
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `${runId}: ${title} · ${run.children.length} children`,
                  },
                ],
                details: run,
              });
            },
            onAgent(prompt, options, childSignal) {
              return controller.schedule(
                (runSignal) => invoke(prompt, options, runSignal),
                childSignal,
              );
            },
          });
          run.status = "completed";
        } catch (error) {
          run.status = controller.signal.aborted ? "aborted" : "failed";
          run.error = error instanceof Error ? error.message : String(error);
        } finally {
          await controller.settle({ abort: run.status !== "completed" });
          run.finishedAt = Date.now();

          if (run.sharedLease && run.sharedChildren?.length) {
            const sharedTasks = (
              await Promise.all(
                run.sharedChildren.map((taskId) =>
                  manager.registry.get(taskId),
                ),
              )
            ).filter((task): task is TaskRecord => task !== undefined);
            const owner = sharedTasks[0];
            const allSucceeded =
              run.status === "completed" &&
              sharedTasks.length === run.sharedChildren.length &&
              sharedTasks.every((task) => task.status === "done");
            for (const task of sharedTasks) {
              await manager.registry.update(task.id, {
                lease: {
                  ...run.sharedLease,
                  returnState: task.id === owner?.id ? "held" : "shared",
                },
                ...(allSucceeded
                  ? {
                      autoCloseCancelled: false,
                      autoCloseAt: Date.now() + 30_000,
                    }
                  : {}),
              });
            }
          }

          await persist(run);
          active.delete(runId);
        }
        return run;
      };

      if (run.background) {
        void execute().then((finished) => {
          try {
            pi.sendMessage(
              {
                customType: "workflow-result",
                content: `Workflow ${finished.runId} ${finished.status}.\n\n${JSON.stringify(finished.result ?? finished.error, null, 2)}`,
                display: true,
                details: finished,
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          } catch {
            /* artifact remains durable */
          }
        });
        return {
          content: [
            {
              type: "text",
              text: `Started background workflow ${runId}${run.name ? ` “${run.name}”` : ""}. Children will be visible in Herdr and completion will be delivered automatically.`,
            },
          ],
          details: run,
        };
      }

      const finished = await execute();
      if (finished.status !== "completed")
        throw new Error(
          `Workflow ${runId} ${finished.status}: ${finished.error}`,
        );
      return {
        content: [
          {
            type: "text",
            text: `Workflow ${runId} completed.\n\n${JSON.stringify(finished.result, null, 2)}\n\nChildren:\n${(
              await Promise.all(
                finished.children.map((child) => manager.registry.get(child)),
              )
            )
              .filter((task): task is TaskRecord => !!task)
              .map(describe)
              .join("\n")}`,
          },
        ],
        details: finished,
      };
    },
    renderCall(args, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      return new (class {
        invalidate() {}
        render() {
          return [
            theme.fg("toolTitle", theme.bold("workflow ")) +
              theme.fg("accent", meta.name ?? "(script)"),
          ];
        }
      })();
    },
  });

  pi.registerMessageRenderer(
    "workflow-result",
    (message, _options, theme) =>
      new (class {
        invalidate() {}
        render(width: number) {
          const content =
            typeof message.content === "string" ? message.content : "";
          return content
            .split("\n")
            .map((line) => theme.fg("muted", line.slice(0, width)));
        }
      })(),
  );

  pi.registerCommand("workflows", {
    description: "List durable workflow runs and child IDs",
    handler: async (rawArgs, ctx) => {
      manager.assertAvailable();
      const requested = rawArgs.trim();
      if (requested) {
        try {
          ctx.ui.notify(
            await readFile(join(runRoot, requested, "workflow.json"), "utf8"),
            "info",
          );
        } catch {
          ctx.ui.notify(`Unknown workflow run ${requested}.`, "warning");
        }
        return;
      }
      let ids: string[] = [];
      try {
        ids = await readdir(runRoot);
      } catch {
        /* no history */
      }
      const runs = await Promise.all(
        ids
          .filter((name) => name.startsWith("wf_"))
          .map(async (name) => {
            try {
              return JSON.parse(
                await readFile(join(runRoot, name, "workflow.json"), "utf8"),
              ) as WorkflowRun;
            } catch {
              return undefined;
            }
          }),
      );
      const rows = [
        ...active.values(),
        ...runs.filter(
          (run): run is WorkflowRun => !!run && !active.has(run.runId),
        ),
      ]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(
          (run) =>
            `${run.runId} [${run.status}] ${run.name ?? "workflow"} · ${run.children.length} children${run.phase ? ` · ${run.phase}` : ""}`,
        );
      ctx.ui.notify(
        rows.length ? rows.join("\n") : "No workflow runs.",
        "info",
      );
    },
  });
}
