import type { TextPart } from "@openchart/server/agent/contracts/part";
import { expect, test } from "vitest";
import { visibleTextPart } from "./visibility";

test("synthetic text stays out of every client transcript", () => {
  const part: TextPart = {
    id: "text",
    messageID: "message",
    type: "text",
    text: "Content",
  };
  expect(visibleTextPart(part)).toBe(true);
  expect(visibleTextPart({ ...part, synthetic: true })).toBe(false);
});
