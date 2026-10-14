// Purpose: Verify known domain failures are classified without exposing unknown causes.

import { ResourceNotFound } from "@openchart/server/lib/resource/errors";
import { expect, test, vi } from "vitest";

import { failureFor } from "./index";

test("classifies a known Resource failure with its public message", () => {
  const failure = failureFor(
    new ResourceNotFound({ resource: "agent_schedule", id: "sch_missing" }),
  );
  expect(failure).toMatchObject({
    status: "NOT_FOUND",
    code: "resource.not_found",
    message: "agent_schedule sch_missing not found",
    details: { error: null },
  });
});

test("hides unknown server failures behind a fixed public message", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const cause = new Error("private database path");
  const failure = failureFor(cause);
  expect(failure).toMatchObject({
    status: "INTERNAL_SERVER_ERROR",
    code: "internal",
    message: "Internal server error",
  });
  expect(JSON.stringify(failure)).not.toContain(cause.message);
  expect(report).toHaveBeenCalledOnce();
  report.mockRestore();
});
