// Purpose: Exposes model choices, native provider inspection, and explicit setup actions.
import { modelChoices } from "@openchart/models/model-tiers";
import { Effect, Schema } from "effect";
import { trpc } from "@openchart/server/lib/trpc";
import { Models } from "./models";
import { NativeProviderID } from "./config";
import { SetupAction } from "./onboarding/setup-state";

const provider = Schema.Struct({ providerID: NativeProviderID });
const operation = Schema.Struct({
  providerID: NativeProviderID,
  id: Schema.String,
});
const input = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.toStandardSchemaV1(schema, {
    parseOptions: { onExcessProperty: "error" },
  });

/** Settings inspects providers independently; one failed query never hides another row.
 * Quota reads each provider's plan meters fresh and never affects discovery.
 * Setup inputs name an action, never a client-supplied shell command.
 * @example const state = await client.models.discover.query({providerID: 'codex'});
 * @example const quota = await client.models.quota.query({providerID: 'codex'});
 */
export const modelsRouter = trpc.router({
  list: trpc.procedure.query(({ ctx }) =>
    ctx.runtime.runPromise(
      Models.Service.use((models) =>
        models
          .list()
          .pipe(Effect.map((providers) => providers.flatMap(modelChoices))),
      ),
    ),
  ),
  discover: trpc.procedure
    .input(input(provider))
    .query(({ ctx, input, signal }) =>
      ctx.runtime.runPromise(
        Models.Service.use((models) => models.discover(input.providerID)),
        { signal },
      ),
    ),
  quota: trpc.procedure.input(input(provider)).query(({ ctx, input, signal }) =>
    ctx.runtime.runPromise(
      Models.Service.use((models) => models.quota(input.providerID)),
      { signal },
    ),
  ),
  refresh: trpc.procedure.mutation(({ ctx }) =>
    ctx.runtime.runPromise(Models.Service.use((models) => models.refresh())),
  ),
  setupState: trpc.procedure
    .input(input(provider))
    .query(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Models.Service.use((models) => models.setup.state(input.providerID)),
      ),
    ),
  startSetup: trpc.procedure
    .input(
      input(
        Schema.Struct({ providerID: NativeProviderID, action: SetupAction }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Models.Service.use((models) =>
          models.setup.start(input.providerID, input.action),
        ),
      ),
    ),
  writeSetup: trpc.procedure
    .input(
      input(
        Schema.Struct({
          ...operation.fields,
          text: Schema.String.check(Schema.isMaxLength(4096)),
        }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Models.Service.use((models) =>
          models.setup.write(input.providerID, input.id, input.text),
        ),
      ),
    ),
  cancelSetup: trpc.procedure
    .input(input(operation))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Models.Service.use((models) =>
          models.setup.cancel(input.providerID, input.id),
        ),
      ),
    ),
});
