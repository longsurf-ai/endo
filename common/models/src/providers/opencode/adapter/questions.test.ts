// Purpose: Verify native question refusal and schema-checked answers.
import { expect, it } from "vitest";
import { answerForm } from "./questions";
const form = {
  mode: "form",
  message: "Choose",
  requestedSchema: {
    type: "object",
    properties: { choice: { type: "string", enum: ["one", "two"] } },
    required: ["choice"],
  },
};
it("cancels questions without a host or with invalid replies", async () => {
  const signal = new AbortController().signal;
  await expect(answerForm(form, undefined, signal)).resolves.toEqual({
    action: "cancel",
  });
  await expect(
    answerForm(form, async () => ({ choice: "invented" }), signal),
  ).resolves.toEqual({ action: "cancel" });
});
it("returns only schema-valid host answers", async () => {
  await expect(
    answerForm(
      form,
      async () => ({ choice: "two" }),
      new AbortController().signal,
    ),
  ).resolves.toEqual({ action: "accept", content: { choice: "two" } });
});
