// Purpose: Proves command definitions reject broken inverses before exposing Parts.
import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { defineCommand } from "./definition";
import { UnsupportedCommandPart } from "./errors";

const echo = {
  name: "echo",
  type: "workflow",
  description: "Echo text",
  template: "$ARGUMENTS",
  buildParts: ({ expandedText }) =>
    Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)))(
      expandedText,
    ).pipe(Effect.map((text) => [{ type: "text", text }])),
  restoreArgumentsFromParts: (parts) =>
    Effect.succeed(
      parts.length === 1 && parts[0]?.type === "text"
        ? parts[0].text
        : undefined,
    ),
} satisfies Parameters<typeof defineCommand>[0];

test("definition is inert; build checks one complete round trip without recursion", async () => {
  const buildParts = vi.fn(echo.buildParts);
  const restoreArgumentsFromParts = vi.fn(echo.restoreArgumentsFromParts);
  const command = defineCommand({
    ...echo,
    buildParts,
    restoreArgumentsFromParts,
  });
  expect(buildParts).not.toHaveBeenCalled();
  expect(restoreArgumentsFromParts).not.toHaveBeenCalled();

  const parts = await Effect.runPromise(command.build("  Research\nGoogle  "));
  expect(parts).toEqual([{ type: "text", text: "Research\nGoogle" }]);
  expect(buildParts).toHaveBeenCalledTimes(2);
  expect(restoreArgumentsFromParts).toHaveBeenCalledExactlyOnceWith(parts);

  buildParts.mockClear();
  restoreArgumentsFromParts.mockClear();
  const before = structuredClone(parts);
  expect(
    await Effect.runPromise(command.restoreArgumentsFromParts(parts)),
  ).toBe("Research\nGoogle");
  expect(buildParts).toHaveBeenCalledOnce();
  expect(restoreArgumentsFromParts).toHaveBeenCalledExactlyOnceWith(parts);
  expect(parts).toEqual(before);
});

test("initial argument errors retain their schema failure and skip restoration", async () => {
  const restoreArgumentsFromParts = vi.fn(echo.restoreArgumentsFromParts);
  const command = defineCommand({ ...echo, restoreArgumentsFromParts });
  expect(
    await Effect.runPromise(command.build("").pipe(Effect.result)),
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "SchemaError" },
  });
  expect(restoreArgumentsFromParts).not.toHaveBeenCalled();
});

test.each([
  {
    name: "does not recognize its own output",
    restore: Effect.succeed(undefined),
  },
  { name: "changes content", restore: Effect.succeed("changed") },
  { name: "produces invalid arguments", restore: Effect.succeed("") },
  {
    name: "rejects its own output",
    restore: Effect.fail(new UnsupportedCommandPart({})),
  },
  {
    name: "fails its inverse schema",
    restore: Schema.decodeUnknownEffect(Schema.String)(123),
  },
])("build fails internally when the inverse $name", async ({ restore }) => {
  const command = defineCommand({
    ...echo,
    restoreArgumentsFromParts: () => restore,
  });
  const admitted = vi.fn();
  // Effect.result captures expected argument failures, but must not turn a
  // broken command definition into an ordinary user-input failure.
  await expect(
    Effect.runPromise(
      command.build("original").pipe(
        Effect.tap(() => Effect.sync(admitted)),
        Effect.result,
      ),
    ),
  ).rejects.toThrow("Command /echo is not reversible.");
  expect(admitted).not.toHaveBeenCalled();
});

test("the same check catches a template that disagrees with the inverse", async () => {
  const command = defineCommand({ ...echo, template: "Prefix: $ARGUMENTS" });
  await expect(Effect.runPromise(command.build("original"))).rejects.toThrow(
    "Command /echo is not reversible.",
  );
});

test("unrelated Parts do not compile and remain available to other commands", async () => {
  const buildParts = vi.fn(echo.buildParts);
  const command = defineCommand({ ...echo, buildParts });
  expect(
    await Effect.runPromise(
      command.restoreArgumentsFromParts([{ type: "compaction", auto: false }]),
    ),
  ).toBeUndefined();
  expect(buildParts).not.toHaveBeenCalled();
});

test.each([
  { restoreArgumentsFromParts: () => Effect.succeed("changed") },
  { restoreArgumentsFromParts: () => Effect.succeed("") },
  {
    restoreArgumentsFromParts: () =>
      Schema.decodeUnknownEffect(Schema.String)(123),
  },
])("external restoration rejects a broken inverse", async (override) => {
  const command = defineCommand({ ...echo, ...override });
  expect(
    await Effect.runPromise(
      command
        .restoreArgumentsFromParts([{ type: "text", text: "original" }])
        .pipe(Effect.result),
    ),
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "Command.UnsupportedPart" },
  });
});

test("restoration compares every field instead of dropping extra input", async () => {
  const command = defineCommand(echo);
  expect(
    await Effect.runPromise(
      command
        .restoreArgumentsFromParts([
          { type: "text", text: "original", metadata: { retain: true } },
        ])
        .pipe(Effect.result),
    ),
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "Command.UnsupportedPart" },
  });
});

test.each(["preserve", "drop", "reverse"] as const)(
  "checks the whole ordered Parts array: %s",
  async (operation) => {
    const command = defineCommand({
      ...echo,
      template: "$1 $2",
      buildParts: ({ captures }) =>
        Effect.succeed([
          { type: "text" as const, text: captures.$1! },
          { type: "text" as const, text: captures.$2! },
        ]),
      restoreArgumentsFromParts: (parts) => {
        const selected =
          operation === "drop"
            ? parts.slice(0, 1)
            : operation === "reverse"
              ? [...parts].reverse()
              : parts;
        return Effect.succeed(
          selected
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(" "),
        );
      },
    });
    if (operation === "preserve") {
      const expected: AgentPromptPartInput[] = [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ];
      expect(await Effect.runPromise(command.build("first second"))).toEqual(
        expected,
      );
      expect(
        await Effect.runPromise(command.restoreArgumentsFromParts(expected)),
      ).toBe("first second");
    } else {
      await expect(
        Effect.runPromise(command.build("first second")),
      ).rejects.toThrow("Command /echo is not reversible.");
    }
  },
);
