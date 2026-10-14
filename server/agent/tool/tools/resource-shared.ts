// Purpose: Shares Resource tool validation, permissions, and recoverable result formatting.

import {
  BlockedError,
  CorrectedError,
  DeclinedError,
} from "@openchart/server/agent/permission/errors";
import * as Tool from "@openchart/server/agent/tool/tool";
import { failureFor } from "@openchart/server/lib/errors";
import {
  STRICT_PARSE_OPTIONS,
  type ResourceDefinition,
  resourceIssues,
} from "@openchart/server/lib/resource";
import {
  resources,
  type ResourceName,
} from "@openchart/server/resources/catalog";
import { assertExists } from "@openchart/utils/assert";
import { Cause, Effect, Schema } from "effect";
import { ResourceArgumentsError } from "./errors";

/** Looks up a Resource whose name was validated against the shared catalog.
 * @example
 * const definition = select('agent_schedule');
 */
export function select(name: typeof ResourceName.Type) {
  const definition: ResourceDefinition | undefined = resources.find(
    (resource) => resource.name === name,
  );
  assertExists(
    definition,
    `Validated Resource ${name} must exist in the catalog.`,
  );
  return definition;
}

/** Decodes Resource input with strict keys and preserves diagnostics for the model.
 * @example
 * const input = yield* parse(definition.listSchema, args, definition.listKeys);
 */
export function parse<
  S extends Schema.Top & { readonly DecodingServices: never },
>(schema: S, input: unknown, allowedKeys?: readonly string[]) {
  return Schema.decodeUnknownEffect(
    schema,
    STRICT_PARSE_OPTIONS,
  )(input).pipe(
    Effect.mapError(
      (error) =>
        new ResourceArgumentsError({
          detail: error.message,
          issues: resourceIssues(error.issue),
          ...(allowedKeys ? { allowedKeys } : {}),
        }),
    ),
  );
}

// Resource failures, including defects, become model feedback after transaction cleanup.
// Cancellation and explicit permission outcomes retain the existing host lifecycle.
/** Formats successful data and recoverable Resource failures as JSON tool output.
 * @example
 * const output = yield* result('Read resource', Effect.succeed({items: []}));
 */
export function result<A, E, R>(
  title: string,
  program: Effect.Effect<A, E, R>,
) {
  const output = (value: unknown): Tool.ExecuteResult => ({
    title,
    metadata: {},
    output: { type: "text", value: JSON.stringify(value) },
  });
  return program.pipe(
    Effect.map((value) => output({ status: "ok", ...value })),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const error = Cause.squash(cause);
      if (
        error instanceof DeclinedError ||
        error instanceof BlockedError ||
        error instanceof CorrectedError
      )
        return Effect.failCause(cause);
      if (error instanceof ResourceArgumentsError) {
        return Effect.succeed(
          output({
            status: "rejected",
            code: "invalid_arguments",
            message: error.detail,
            ...(error.allowedKeys ? { allowedKeys: error.allowedKeys } : {}),
            ...(error.issues ? { issues: error.issues } : {}),
          }),
        );
      }
      const failure = failureFor(error);
      return Effect.succeed(
        output({
          status: "rejected",
          code: failure.code,
          message: failure.message,
          ...(failure.details.resourceStateInvalid ?? {}),
          ...(failure.code === "internal"
            ? {
                recovery:
                  "Read the affected resource to check its current state before deciding whether to retry. Do not assume a write succeeded or failed.",
              }
            : {}),
        }),
      );
    }),
  );
}

/** Uses the existing approval lifecycle with Resource names as permission patterns.
 * @example
 * yield* ask(context, 'resource_read', ['agent_schedule'], {resource: 'agent_schedule'});
 */
export function ask(
  context: Tool.Context,
  permission: string,
  patterns: readonly string[],
  metadata: Tool.Metadata,
) {
  return context.ask({ permission, patterns, always: patterns, metadata });
}
