// Purpose: Lists slash commands and builds prompt Parts without submitting them.
import { Effect, Schema } from "effect";
import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { catalog, definitions } from "./catalog";
import {
  InvalidCommandInput,
  UnknownCommand,
  UnsupportedCommandPart,
} from "./errors";
import { hints } from "./template";
import type { Definition } from "./definition";

/** Arguments for constructing Parts, independent of a Session or prompt submission. */
export const BuildCommandRequest = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)),
  arguments: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Returns serializable menu data, never executable builders. @example listCommands(); */
export function listCommands() {
  return definitions.map(
    ({ name, type, description, argumentHint, template }: Definition) => ({
      name,
      type,
      description,
      argumentHint,
      hints: hints(template),
    }),
  );
}

/**
 * Builds serializable input Parts using the command's argument schema.
 * Unknown commands and invalid arguments fail without model or storage I/O.
 * Callers assemble a complete prompt and submit it through agent.prompt.
 * @example const parts = yield* buildCommand({command: 'best-of-n', arguments: '3 research Google'});
 */
export const buildCommand = Effect.fn("Command.build")(
  function* (request: typeof BuildCommandRequest.Type) {
    const definition = catalog.get(request.command);
    if (!definition)
      return yield* new UnknownCommand({ name: request.command });
    return yield* definition.build(request.arguments);
  },
  (effect, request) =>
    effect.pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(
          new InvalidCommandInput({
            name: request.command,
            detail: error.message,
          }),
        ),
      ),
    ),
);

/**
 * Restores a composer command Part to canonical editable arguments. Recompiles
 * at the command owner to reject any information loss, including extra fields.
 * Unsupported Parts fail without creating a Session or performing storage I/O.
 * @example const command = yield* restoreCommand({type: 'compaction', auto: false});
 */
export const restoreCommand = Effect.fn("Command.restore")(function* (
  part: AgentPromptPartInput,
) {
  for (const definition of definitions) {
    const args = yield* definition.restoreArgumentsFromParts([part]);
    if (args === undefined) continue;
    return { command: definition.name, arguments: args };
  }
  return yield* new UnsupportedCommandPart({});
});
