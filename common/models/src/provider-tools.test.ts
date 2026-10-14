// Purpose: Verifies generated tool input schemas retain object shapes and JSON constraints.

import { expect, test } from "vitest";
import { providerToolInputSchema } from "./provider-tools";

test("converts referenced object schemas without changing their source", () => {
  const schema = {
    $ref: "#/definitions/Search",
    definitions: {
      Search: {
        type: "object" as const,
        properties: {
          query: { type: "string" as const },
          count: { type: "integer" as const, enum: [1, 2] },
        },
        required: ["query", "count"],
        additionalProperties: false,
      },
    },
  };
  const before = structuredClone(schema);
  const parameters = providerToolInputSchema(schema);
  expect("shape" in parameters).toBe(true);
  expect(parameters.safeParse({ query: "AAPL", count: 1 }).success).toBe(true);
  expect(parameters.safeParse({ query: "AAPL", count: "1" }).success).toBe(
    false,
  );
  expect(parameters.safeParse({ query: "AAPL", count: 3 }).success).toBe(false);
  expect(parameters.safeParse({ query: "AAPL" }).success).toBe(false);
  expect(schema).toEqual(before);
});
