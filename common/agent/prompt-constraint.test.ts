// Purpose: Keeps schema refinements and composer parsing on the same lossless constraint.

import { expect, test } from "vitest";
import { directiveFormatter } from "./directive-formatter";
import {
  checkPromptConstraint,
  parseComposerParts,
  readLeadingCommand,
} from "./prompt-constraint";

const text = { type: "text", text: "  Review AAPL.\n" };
const quote = { type: "context", context: { kind: "quote", text: "" } };
const image = {
  type: "file",
  mime: "image/png",
  filename: "",
  url: "data:image/png;base64,YQ==",
};
const workflow = {
  type: "workflow",
  workflow: "default:workflows/multi-turn-debate.workflow.ts",
  args: { round: 3, topic: "Should I buy AAPL?" },
};

test.each([
  { parts: [] },
  { parts: [text] },
  { parts: [quote] },
  { parts: [image, image] },
  { parts: [workflow] },
  { parts: [quote, text, image] },
  { parts: [quote, workflow, image] },
  { parts: [{ type: "compaction", auto: false }] },
  { parts: [{ type: "text", text: " /compact" }] },
  {
    parts: [
      {
        type: "text",
        text: directiveFormatter.serialize({
          type: "file",
          id: "a].tea",
          label: "a].tea",
        }),
      },
    ],
  },
])("preserves accepted Parts for both consumers: $parts", ({ parts }) => {
  const before = structuredClone(parts);
  expect(checkPromptConstraint({ parts })).toBeUndefined();
  expect(parseComposerParts(parts)).toEqual(before);
  expect(parts).toEqual(before);
});

test.each([
  { name: "text with workflow", parts: [text, workflow] },
  { name: "workflow with text", parts: [workflow, text] },
  { name: "text after image", parts: [image, text] },
  { name: "two quotes", parts: [quote, quote] },
  { name: "empty text", parts: [{ type: "text", text: "" }] },
  { name: "raw command", parts: [{ type: "text", text: "/compact" }] },
  {
    name: "command chip",
    parts: [{ type: "text", text: ":command[/compact]{name=compact}" }],
  },
  { name: "part identity", parts: [{ ...text, id: "prt_original" }] },
  { name: "synthetic text", parts: [{ ...text, synthetic: true }] },
  { name: "metadata", parts: [{ ...text, metadata: {} }] },
  { name: "unknown field", parts: [{ ...text, unknown: "keep me" }] },
  {
    name: "quote source",
    parts: [
      { ...quote, context: { ...quote.context, messageId: "msg_source" } },
    ],
  },
  { name: "non-image file", parts: [{ ...image, mime: "application/pdf" }] },
  { name: "missing filename", parts: [{ ...image, filename: undefined }] },
  { name: "automatic compaction", parts: [{ type: "compaction", auto: true }] },
])("rejects $name for both consumers without mutation", ({ parts }) => {
  const before = structuredClone(parts);
  expect(checkPromptConstraint({ parts })).toMatchObject({ path: ["parts"] });
  expect(() => parseComposerParts(parts)).toThrow();
  expect(parts).toEqual(before);
});

test("shares command chip escaping and preserves arguments verbatim", () => {
  const command = "command]with}escapes\\and\nnewline";
  const chip = directiveFormatter.serialize({
    type: "command",
    label: "/command",
    id: command,
  });
  expect(readLeadingCommand(`${chip}  arguments\n`)).toEqual({
    command,
    arguments: " arguments\n",
  });
  expect(readLeadingCommand("/best-of-n 3 research\n")).toEqual({
    command: "best-of-n",
    arguments: "3 research\n",
  });
});
