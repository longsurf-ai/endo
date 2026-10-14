import { expect, test, vi } from "vitest";
import {
  toPromptParts,
  type PromptParts,
} from "@openchart/app/lib/prompt-converter/converter";

test.each([
  "Explain /compact",
  " /compact",
  "/",
  "//path",
  "Research\n/best-of-n 3 Google",
  "Explain :command[/compact]{name=compact}",
  ":file[report.tea]{name=/workspace/report.tea}",
])("preserves ordinary text: %s", async (text) => {
  const build = vi.fn();
  expect(
    await toPromptParts({ text, quote: undefined, attachments: [] }, build),
  ).toEqual([{ type: "text", text }]);
  expect(build).not.toHaveBeenCalled();
});

test.each([
  ["/compact", "compact", ""],
  [":command[/compact]{name=compact} ", "compact", ""],
  [":command[compact]", "compact", ""],
  [
    ':command[/best-of-n]{name=best-of-n} 3  "research Google"\n:file[report.tea] /compact',
    "best-of-n",
    '3  "research Google"\n:file[report.tea] /compact',
  ],
  [":command[/best-of-n]{name=best-of-n}3 Google", "best-of-n", "3 Google"],
  [
    "/best-of-n 3  research\nGoogle /compact",
    "best-of-n",
    "3  research\nGoogle /compact",
  ],
  [
    '/new-command "first argument" second',
    "new-command",
    '"first argument" second',
  ],
])("builds only the leading command: %s", async (text, command, args) => {
  const parts: PromptParts = [
    { type: "workflow", workflow: "workspace:test.workflow.ts", args: {} },
  ];
  const build = vi.fn().mockResolvedValue(parts);
  const draft = {
    text,
    quote: { text: "Keep this quote", messageId: "source" },
    attachments: [],
  };
  const before = structuredClone(draft);
  expect(await toPromptParts(draft, build)).toEqual([
    { type: "context", context: { kind: "quote", text: "Keep this quote" } },
    ...parts,
  ]);
  expect(build).toHaveBeenCalledExactlyOnceWith({ command, arguments: args });
  expect(draft).toEqual(before);
});

test("uses backend parts for compact and propagates construction errors", async () => {
  const draft = { text: "/compact", quote: undefined, attachments: [] };
  const build = vi
    .fn()
    .mockResolvedValue([{ type: "compaction", auto: false }]);
  expect(await toPromptParts(draft, build)).toEqual([
    { type: "compaction", auto: false },
  ]);
  build.mockRejectedValue(new Error("Invalid command arguments"));
  await expect(toPromptParts(draft, build)).rejects.toThrow(
    "Invalid command arguments",
  );
  expect(draft.text).toBe("/compact");
});
