// Purpose: Reads existing Resources through the workflow host.
import { Effect, Schema } from "effect";
import { Workflow } from "@openchart/server/agent/workflow";

/**
 * Reads a Resource at execution time and decodes the fields a program consumes.
 * The host owns Resource lookup without a separate permission check. This starts
 * no Agent and performs no writes. Missing resources and invalid data fail the workflow.
 * The codec may select a subset of the entity; each invocation reads afresh.
 * @example const row = yield* resource.get("agent_schedule", id, ScheduleFields);
 */
export const get = <S extends Schema.Decoder<unknown>>(
  name: string,
  id: string,
  schema: S,
) =>
  Effect.gen(function* () {
    const host = yield* Workflow.Service;
    return yield* Schema.decodeUnknownEffect(schema)(
      yield* host.getResource(name, id),
    );
  });
