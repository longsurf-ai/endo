// Purpose: Defines commands whose construction and restoration enforce the same round trip.

import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { assertTrue } from "@openchart/utils/assert";
import { Effect, type Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { expandTemplate, type Expansion } from "./template";
import { UnsupportedCommandPart } from "./errors";

interface CommandDefinition<Part extends AgentPromptPartInput> {
  readonly type: "workflow" | "compaction";
  readonly name: string;
  readonly description: string;
  /** Display-only usage guidance; commands without arguments may omit it. */
  readonly argumentHint?: string;
  readonly template: string;
  /** Builds Parts without executing them. @example buildParts: ({expandedText}) => Effect.succeed([{type: 'text', text: expandedText}]) */
  readonly buildParts: (
    expansion: Expansion,
  ) => Effect.Effect<Part[], Schema.SchemaError>;
  /** Returns undefined when these Parts do not belong to this command. */
  readonly restoreArgumentsFromParts: (
    parts: readonly AgentPromptPartInput[],
  ) => Effect.Effect<
    string | undefined,
    Schema.SchemaError | UnsupportedCommandPart
  >;
}

/**
 * Binds the template, builder, and inverse behind checked command methods.
 * Construction validates arguments, then restores and recompiles before exposing
 * Parts. A broken inverse is an internal defect; invalid input retains its schema
 * failure. Restoration rejects lossy input and returns undefined for other commands.
 * Raw callbacks stay private and must be pure; definition performs no I/O or execution.
 * @example const command = defineCommand({name: 'example', type: 'workflow', description: 'Example', template: '$1', buildParts, restoreArgumentsFromParts});
 */
export function defineCommand<Part extends AgentPromptPartInput>({
  buildParts,
  restoreArgumentsFromParts,
  ...metadata
}: CommandDefinition<Part>) {
  const compile = Effect.fn("CommandDefinition.compile")(function* (
    argumentsText: string,
  ) {
    return yield* buildParts(expandTemplate(metadata.template, argumentsText));
  });

  const restore = Effect.fn("CommandDefinition.restore")(
    function* (parts: readonly AgentPromptPartInput[]) {
      const args = yield* restoreArgumentsFromParts(parts);
      if (args === undefined) return undefined;
      const rebuilt = yield* compile(args);
      if (!isDeepStrictEqual(rebuilt, parts))
        return yield* new UnsupportedCommandPart({});
      return args;
    },
    Effect.catchTag("SchemaError", () =>
      Effect.fail(new UnsupportedCommandPart({})),
    ),
  );

  const build = Effect.fn("CommandDefinition.build")(function* (
    argumentsText: string,
  ) {
    const parts = yield* compile(argumentsText);
    const invariant = `Command /${metadata.name} is not reversible.`;
    // @agent invariant: Never expose built Parts until the same definition
    // restores and recompiles them exactly. Call raw compile to avoid recursion.
    const restored = yield* restore(parts).pipe(
      Effect.catch((cause) => Effect.die(new Error(invariant, { cause }))),
    );
    assertTrue(restored !== undefined, invariant);
    return parts;
  });

  return { ...metadata, build, restoreArgumentsFromParts: restore };
}

/** A catalog entry exposing only the checked operations created by defineCommand. */
export type Definition = ReturnType<typeof defineCommand>;
