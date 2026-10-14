// Purpose: Publish live OpenTelemetry span snapshots through ordinary workflow tool progress.

import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  BasicTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Schema, Semaphore } from "effect";

/** Awaited progress, installed per invocation; standalone authoring has no UI sink. */
export const PublishTrace = Context.Reference<Effect.Effect<void, unknown>>(
  "@openchart/workflow/PublishTrace",
  { defaultValue: () => Effect.void },
);

const decodeTrace = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.JsonObject),
);

/**
 * Installs the official Effect/OTel bridge for one workflow. SDK spans are the
 * only in-memory trace state; the official serializer produces OTLP-shaped JSON.
 * Live snapshots use endTimeUnixNano=0 for unfinished spans as an internal UI
 * convention. Only completed snapshots are standard OTLP export payloads.
 * Publication is awaited and serialized, so concurrent children cannot replace
 * newer metadata with an older snapshot. No exporter or detached writer is used.
 * @example
 * yield* withWorkflowTracing(program, trace => ctx.metadata({metadata: {trace}}));
 */
export const withWorkflowTracing = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  publish: (trace: Schema.JsonObject) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const spans: ReadableSpan[] = [];
    const provider = new BasicTracerProvider({
      spanProcessors: [
        {
          // TODO: Separate live UI progress from standard OTLP export. We currently
          // serialize unfinished spans with endTimeUnixNano=0, which violates OTLP
          // timing requirements. Switching to onEnd alone hides running steps and
          // delays their Session links. Keep start-time collection/publication until
          // backend and frontend support live progress alongside completed OTLP spans.
          onStart(span) {
            // Retain the SDK span so later snapshots include its final state.
            if (span.name.startsWith("Workflow.")) spans.push(span);
          },
          onEnd() {},
          forceFlush: async () => {},
          shutdown: async () => {},
        },
      ],
    });
    const tracer = yield* OtelTracer.make.pipe(
      Effect.provideService(
        OtelTracer.OtelTracer,
        provider.getTracer("@openchart/workflow"),
      ),
    );
    const lock = yield* Semaphore.make(1);
    const publishTrace = lock.withPermit(
      Effect.suspend(() =>
        publish(
          decodeTrace(
            new TextDecoder().decode(
              JsonTraceSerializer.serializeRequest(spans),
            ),
          ),
        ),
      ),
    );
    return yield* program.pipe(
      Effect.withTracer(tracer),
      Effect.provideService(PublishTrace, publishTrace),
      Effect.ensuring(Effect.promise(() => provider.shutdown())),
    );
  });
