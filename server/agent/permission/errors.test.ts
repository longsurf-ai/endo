// Purpose: Verifies permission failures retain meaningful feedback through Error.message.

import { describe, expect, test } from "vitest";
import { BlockedError, CorrectedError, DeclinedError } from "./errors";

describe("permission error messages", () => {
  test("corrective feedback reaches consumers of the standard Error interface", () => {
    const feedback = "Do not edit that file.\nRead /public/report.md instead.";
    const error = new CorrectedError({ feedback });

    expect(error.message).toBe(`The user declined this operation: ${feedback}`);
    expect(String(error)).toContain(feedback);
    expect(error.feedback).toBe(feedback);
  });

  test("policy blocks summarize rule decisions without losing action or resource", () => {
    const error = new BlockedError({
      rules: [
        { decision: "deny", action: "edit", resource: "/private/*" },
        { decision: "allow", action: "read", resource: "/public/*" },
      ],
    });
    expect(error.message).toBe(
      "Permission policy blocks this operation. Rules: deny edit /private/*; allow read /public/*",
    );
    expect(new BlockedError({ rules: [] }).message).toBe(
      "Permission policy blocks this operation.",
    );
  });

  test("declining without feedback has a readable message", () => {
    expect(new DeclinedError({}).message).toBe(
      "Permission for this operation was declined.",
    );
  });
});
