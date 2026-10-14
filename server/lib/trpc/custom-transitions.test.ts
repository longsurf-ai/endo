// Purpose: Preserves custom transition input codecs, result types, and runtime service requirements at tRPC.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { defineId } from "@openchart/identifier";
import { makeRuntime } from "@openchart/server/runtime";
import { Database } from "@openchart/server/db";
import {
  defineResource,
  envelopeFields,
  Transition,
} from "@openchart/server/lib/resource";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createTRPCClient, httpLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { ConfigProvider, Context, Deferred, Effect, Schema } from "effect";
import { expect, expectTypeOf, test, vi } from "vitest";

import { resourceRouter } from "./resource-router";

const entity = Schema.Struct({
  ...envelopeFields(defineId("ex", "Example.ID")),
  name: Schema.String,
});
const unused = () => {
  throw new Error("This operation must not use the store");
};
const store = {
  load: unused,
  list: unused,
  insert: unused,
  save: unused,
  remove: unused,
};

test("queries and mutations preserve wire codecs, results, and their HTTP methods", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  const resolve = vi.fn((input: { readonly value: number }) =>
    Effect.gen(function* () {
      yield* Database.Service;
      return input.value * 2;
    }),
  );
  const resource = defineResource({
    name: "example",
    entity,
    store,
    transitions: {
      double: Transition.make({
        input: Schema.Struct({ value: Schema.NumberFromString }),
        resolve,
        apply: (_tx, input, doubled) =>
          Effect.succeed({ input: input.value, doubled }),
      }),
      readDouble: Transition.make({
        kind: "query",
        input: Schema.Struct({ value: Schema.NumberFromString }),
        resolve,
        apply: (_tx, input, doubled) =>
          Effect.succeed({ input: input.value, doubled }),
      }),
    },
  });
  const router = resourceRouter(resource);
  type Inputs = inferRouterInputs<typeof router>;
  type Outputs = inferRouterOutputs<typeof router>;
  expectTypeOf<Inputs["double"]>().toEqualTypeOf<{ readonly value: string }>();
  expectTypeOf<Outputs["double"]>().toEqualTypeOf<{
    input: number;
    doubled: number;
  }>();
  expectTypeOf<Inputs["readDouble"]>().toEqualTypeOf<Inputs["double"]>();
  expectTypeOf<Outputs["readDouble"]>().toEqualTypeOf<Outputs["double"]>();
  const methods: string[] = [];
  const client = createTRPCClient<typeof router>({
    links: [
      httpLink({
        url: "http://localhost/trpc",
        fetch: (input, init) => {
          const req = new Request(input, init);
          methods.push(req.method);
          return fetchRequestHandler({
            endpoint: "/trpc",
            req,
            router,
            createContext: () => ({ runtime }),
          });
        },
      }),
    ],
  });
  expectTypeOf(client.readDouble).toHaveProperty("query");
  expectTypeOf(client.readDouble).not.toHaveProperty("mutate");
  expectTypeOf(client.double).toHaveProperty("mutate");
  expectTypeOf(client.double).not.toHaveProperty("query");
  try {
    await expect(client.double.mutate({ value: "21" })).resolves.toEqual({
      input: 21,
      doubled: 42,
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ value: 21 });
    await expect(client.readDouble.query({ value: "12" })).resolves.toEqual({
      input: 12,
      doubled: 24,
    });
    expect(resolve).toHaveBeenLastCalledWith({ value: 12 });
    expect(methods).toEqual(["POST", "GET"]);
    await expect(
      client.double.mutate({ value: "21", extra: true } as never),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    await expect(
      client.readDouble.query({ value: "12", extra: true } as never),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    expect(resolve).toHaveBeenCalledTimes(2);
  } finally {
    await runtime.dispose();
  }
});

class Unavailable extends Context.Service<
  Unavailable,
  { readonly name: string }
>()("Test.Unavailable") {}

test("aborting a query releases resolved resources without entering apply", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  const started = Deferred.makeUnsafe<void>();
  const released = vi.fn();
  const apply = vi.fn(() => Effect.void);
  const resource = defineResource({
    name: "example",
    entity,
    store,
    transitions: {
      inspect: Transition.make({
        kind: "query",
        input: Schema.Void,
        resolve: () =>
          Effect.scoped(
            Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
              Effect.sync(released),
            ).pipe(Effect.andThen(Effect.never)),
          ),
        apply,
      }),
    },
  });
  const controller = new AbortController();
  const response = fetchRequestHandler({
    endpoint: "/trpc",
    req: new Request("http://localhost/trpc/inspect", {
      signal: controller.signal,
    }),
    router: resourceRouter(resource),
    createContext: () => ({ runtime }),
  });
  try {
    await runtime.runPromise(Deferred.await(started));
    controller.abort();
    await response;
    expect(released).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await runtime.dispose();
  }
});

test("rejects a Resource whose custom resolver requires a service absent from the application runtime", () => {
  const resource = defineResource({
    name: "example",
    entity,
    store,
    transitions: {
      unavailable: Transition.make({
        kind: "query",
        input: Schema.Void,
        resolve: () =>
          Effect.gen(function* () {
            return yield* Unavailable;
          }),
        apply: (_tx, _input, resolved) => Effect.succeed(resolved.name),
      }),
    },
  });
  expectTypeOf(resource).not.toExtend<Parameters<typeof resourceRouter>[0]>();
});
