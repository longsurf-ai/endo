import { type Part } from "@openchart/server/agent/contracts/part";
import { assertExists } from "@openchart/utils/assert";
import { createParts } from "./create-parts";
import { Effect } from "effect";

/**
 * Inserts a new Part and publishes it after commit, using its Message's Session.
 *
 * Call outside any existing transaction. Duplicate IDs fail without publishing.
 *
 * @example
 * ```ts
 * const saved = yield* createPart(part);
 * ```
 */
export const createPart = Effect.fn("Message.createPart")(function* <
  P extends Part,
>(part: P) {
  const [saved] = yield* createParts([part]);
  assertExists(saved, "A successful Part insert must return its saved Part");
  return saved;
});
