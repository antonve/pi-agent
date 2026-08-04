import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import {
  shouldRenderToolPart,
  type CalmToolOutputMode,
} from "../shared/calm-tool-output.ts";

type DefinitionFactory<TParams extends TSchema, TDetails, TState> = (
  cwd: string,
) => ToolDefinition<TParams, TDetails, TState>;

type RenderCall<TParams extends TSchema, TDetails, TState> = NonNullable<
  ToolDefinition<TParams, TDetails, TState>["renderCall"]
>;

type RenderResult<TParams extends TSchema, TDetails, TState> = NonNullable<
  ToolDefinition<TParams, TDetails, TState>["renderResult"]
>;

type CompactRenderCall<TParams extends TSchema, TDetails, TState> = RenderCall<
  TParams,
  TDetails,
  TState
>;

function sanitizeCalmLine(value: unknown) {
  return String(value ?? "")
    .replace(
      /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g,
      "",
    )
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function registerCalmBuiltIn<TParams extends TSchema, TDetails, TState>(
  pi: ExtensionAPI,
  factory: DefinitionFactory<TParams, TDetails, TState>,
  mode: CalmToolOutputMode,
  compactRenderCall?: CompactRenderCall<TParams, TDetails, TState>,
) {
  const definitions = new Map<
    string,
    ToolDefinition<TParams, TDetails, TState>
  >();
  const definitionFor = (cwd: string) => {
    let definition = definitions.get(cwd);
    if (!definition) {
      definition = factory(cwd);
      definitions.set(cwd, definition);
    }
    return definition;
  };

  const original = definitionFor(process.cwd());
  const renderedComponents = new WeakMap<
    object,
    { call?: Component; result?: Component }
  >();
  const componentsFor = (state: TState) => {
    const key = state as object;
    let components = renderedComponents.get(key);
    if (!components) {
      components = {};
      renderedComponents.set(key, components);
    }
    return components;
  };
  const renderCall = original.renderCall as
    | RenderCall<TParams, TDetails, TState>
    | undefined;
  const renderResult = original.renderResult as
    | RenderResult<TParams, TDetails, TState>
    | undefined;

  if (!renderCall || !renderResult) {
    throw new Error(
      `Calm tool output requires both renderers for built-in ${original.name}.`,
    );
  }

  pi.registerTool<TParams, TDetails, TState>({
    ...original,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return definitionFor(ctx.cwd).execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },

    renderCall(args, theme, context) {
      if (
        !shouldRenderToolPart(mode, "call", context.expanded, context.isError)
      )
        return new Container();
      const components = componentsFor(context.state);
      if (!context.expanded && !context.isError && compactRenderCall) {
        components.call = compactRenderCall(args, theme, context);
        return components.call;
      }
      components.call = (definitionFor(context.cwd).renderCall ?? renderCall)(
        args,
        theme,
        { ...context, lastComponent: components.call },
      );
      return components.call;
    },

    renderResult(result, options, theme, context) {
      if (
        !shouldRenderToolPart(mode, "result", options.expanded, context.isError)
      )
        return new Container();
      const components = componentsFor(context.state);
      components.result = (
        definitionFor(context.cwd).renderResult ?? renderResult
      )(result, options, theme, {
        ...context,
        lastComponent: components.result,
      });
      return components.result;
    },
  });
}

/**
 * Calm collapsed rendering for high-frequency built-ins. Ctrl+O restores each
 * stock renderer in full; tool execution and Pi's Working row are untouched.
 */
export default function calmToolOutput(pi: ExtensionAPI) {
  registerCalmBuiltIn(pi, createReadToolDefinition, "hidden");
  registerCalmBuiltIn(pi, createBashToolDefinition, "compact");
  registerCalmBuiltIn(
    pi,
    createEditToolDefinition,
    "compact",
    (args, theme) =>
      new Text(
        theme.fg("toolTitle", theme.bold("edit")) +
          theme.fg("muted", ` ${sanitizeCalmLine(args.path)}`),
        0,
        0,
      ),
  );
  registerCalmBuiltIn(pi, createWriteToolDefinition, "compact");
}
