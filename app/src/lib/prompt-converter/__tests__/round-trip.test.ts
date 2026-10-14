// Purpose: Locks the reversible composer subset and rejects silent content loss.
import type { CompleteAttachment } from "@assistant-ui/react";
import { expect, test, vi } from "vitest";
import {
  fromPromptParts,
  readLeadingCommand,
  toPromptParts,
  type ComposerDraft,
  type PromptParts,
} from "@openchart/app/lib/prompt-converter/converter";
import { directiveFormatter } from "@openchart/app/lib/prompt-converter/directive-formatter";

const images: CompleteAttachment[] = [
  {
    id: "original-image-1",
    type: "image",
    name: "€ chart.png",
    contentType: "image/png",
    status: { type: "complete" },
    content: [{ type: "image", image: "data:image/png;base64,YQ==" }],
  },
  {
    id: "original-image-2",
    type: "image",
    name: "",
    contentType: "image/webp",
    status: { type: "complete" },
    content: [{ type: "image", image: "https://example.com/chart.webp" }],
  },
];

const texts = [
  "",
  " \t\n ",
  "  Analyze this chart 👀\r\nKeep every space.  ",
  "Explain /compact",
  " /compact",
  "/",
  "//path",
  directiveFormatter.serialize({
    type: "file",
    id: "/workspace/quoted]file}\\\n.tea",
    label: "quoted]file}\\\n.tea",
  }),
];

test.each(
  texts.flatMap((text) =>
    [
      undefined,
      { text: "Quote\n  verbatim  ", messageId: "source-message" },
    ].flatMap((quote) =>
      [[], images].map((attachments) => ({ text, quote, attachments })),
    ),
  ),
)("round-trips text, quote, and images: %j", async (draft: ComposerDraft) => {
  const before = structuredClone(draft);
  const build = vi.fn();
  const restore = vi.fn();
  const parts = await toPromptParts(draft, build);
  const beforeParts = structuredClone(parts);
  const restored = await fromPromptParts(parts, restore);

  expect(restored.text).toBe(draft.text);
  expect(restored.quote?.text).toBe(draft.quote?.text);
  expect(restored.attachments).toEqual(
    draft.attachments.map((image) => ({ ...image, id: expect.any(String) })),
  );
  expect(await toPromptParts(restored, build)).toEqual(parts);
  expect(parts).toEqual(beforeParts);
  expect(draft).toEqual(before);
  expect(build).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
});

test("preserves empty quote text and recreates only editor identities", async () => {
  const file = new File(["image"], "€ chart.png", {
    type: "image/png",
    lastModified: 123,
  });
  const draft: ComposerDraft = {
    text: "",
    quote: { text: "", messageId: "original-message" },
    attachments: [{ ...images[0]!, file }, images[0]!],
  };
  const parts = await toPromptParts(draft, vi.fn());
  const restored = await fromPromptParts(parts, vi.fn());
  const reopened = await fromPromptParts(parts, vi.fn());

  expect(restored.quote).toEqual({ text: "", messageId: expect.any(String) });
  expect(restored.quote?.messageId).not.toBe("original-message");
  expect(new Set(restored.attachments.map((image) => image.id)).size).toBe(2);
  expect(restored.attachments[0]?.id).not.toBe(reopened.attachments[0]?.id);
  expect(restored.attachments[0]).not.toHaveProperty("file");
  expect(draft.attachments[0]?.file).toBe(file);
  expect(await toPromptParts(restored, vi.fn())).toEqual(parts);
});

const commands: {
  command: string;
  arguments: string;
  part: PromptParts[number];
}[] = [
  {
    command: "compact",
    arguments: "",
    part: { type: "compaction", auto: false },
  },
  {
    command: "best-of-n",
    arguments: '3 "Research" "Google"',
    part: {
      type: "workflow",
      workflow: "default:workflows/best-of-n.workflow.ts",
      args: { n: 3, question: "Research Google" },
    },
  },
  {
    command: "multi-turn-debate",
    arguments: '2 "Should public transit" "be free?"',
    part: {
      type: "workflow",
      workflow: "default:workflows/multi-turn-debate.workflow.ts",
      args: { round: 2, topic: "Should public transit be free?" },
    },
  },
];

test.each(commands)(
  "delegates $command and restores an editable command chip",
  async ({ part, ...command }) => {
    // Real command compilation/restoration is covered at the server command owner.
    const restore = vi.fn().mockResolvedValue(command);
    const build = vi.fn().mockResolvedValue([part]);
    const parts: PromptParts = [
      { type: "context", context: { kind: "quote", text: "quote" } },
      part,
      {
        type: "file",
        mime: "image/png",
        filename: "€ chart.png",
        url: "data:image/png;base64,YQ==",
      },
    ];
    const before = structuredClone(parts);
    const draft = await fromPromptParts(parts, restore);

    expect(draft.text).toBe(
      `:command[/${command.command}]{name=${command.command}}${command.arguments ? ` ${command.arguments}` : ""}`,
    );
    expect(readLeadingCommand(draft.text)).toEqual(command);
    expect(restore).toHaveBeenCalledExactlyOnceWith(part);
    expect(await toPromptParts(draft, build)).toEqual(parts);
    expect(build).toHaveBeenCalledExactlyOnceWith(command);
    expect(parts).toEqual(before);
  },
);

const unsupported: { name: string; parts: PromptParts }[] = [
  {
    name: "multiple text parts",
    parts: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  },
  { name: "empty text part", parts: [{ type: "text", text: "" }] },
  {
    name: "text that would execute a command",
    parts: [{ type: "text", text: "/compact" }],
  },
  {
    name: "text that would execute a command chip",
    parts: [{ type: "text", text: ":command[/compact]{name=compact}" }],
  },
  {
    name: "quote after text",
    parts: [
      { type: "text", text: "a" },
      { type: "context", context: { kind: "quote", text: "b" } },
    ],
  },
  {
    name: "multiple quotes",
    parts: [
      { type: "context", context: { kind: "quote", text: "a" } },
      { type: "context", context: { kind: "quote", text: "b" } },
    ],
  },
  {
    name: "non-quote context",
    parts: [
      {
        type: "context",
        context: { kind: "document", title: "doc", text: "content" },
      },
    ],
  },
  { name: "automatic compaction", parts: [{ type: "compaction", auto: true }] },
  {
    name: "part identity",
    parts: [{ type: "text", text: "a", id: "prt_original" }],
  },
  {
    name: "synthetic text",
    parts: [{ type: "text", text: "a", synthetic: true }],
  },
  {
    name: "text metadata",
    parts: [{ type: "text", text: "a", metadata: { important: true } }],
  },
  {
    name: "text timing",
    parts: [{ type: "text", text: "a", time: { start: 1 } }],
  },
  {
    name: "non-image file",
    parts: [
      {
        type: "file",
        mime: "application/pdf",
        filename: "a.pdf",
        url: "https://example.com/a.pdf",
      },
    ],
  },
  {
    name: "missing image filename",
    parts: [
      { type: "file", mime: "image/png", url: "https://example.com/a.png" },
    ],
  },
  {
    name: "file provenance",
    parts: [
      {
        type: "file",
        mime: "image/png",
        filename: "a.png",
        url: "https://example.com/a.png",
        source: {
          type: "file",
          path: "a.png",
          text: { value: "a.png", start: 0, end: 5 },
        },
      },
    ],
  },
  {
    name: "text after images",
    parts: [
      {
        type: "file",
        mime: "image/png",
        filename: "a.png",
        url: "https://example.com/a.png",
      },
      { type: "text", text: "a" },
    ],
  },
  {
    name: "command alongside text",
    parts: [
      { type: "text", text: "a" },
      { type: "compaction", auto: false },
    ],
  },
  {
    name: "workflow after text",
    parts: [
      { type: "text", text: "Review the alert." },
      {
        type: "workflow",
        workflow: "default:workflows/multi-turn-debate.workflow.ts",
        args: { round: 3, topic: "Should I buy AAPL?" },
      },
    ],
  },
  {
    name: "text after workflow",
    parts: [
      {
        type: "workflow",
        workflow: "default:workflows/multi-turn-debate.workflow.ts",
        args: { round: 3, topic: "Should I buy AAPL?" },
      },
      { type: "text", text: "Review the alert." },
    ],
  },
];

test.each(unsupported)(
  "rejects $name instead of losing information",
  async ({ parts }) => {
    const before = structuredClone(parts);
    await expect(fromPromptParts(parts, vi.fn())).rejects.toThrow();
    expect(parts).toEqual(before);
  },
);

test("propagates command restoration errors without changing input", async () => {
  const parts: PromptParts = [
    { type: "workflow", workflow: "workspace:unknown.workflow.ts", args: {} },
  ];
  const before = structuredClone(parts);
  const error = new Error("Unsupported command Part");
  await expect(
    fromPromptParts(parts, vi.fn().mockRejectedValue(error)),
  ).rejects.toBe(error);
  expect(parts).toEqual(before);
});

test.each([
  { ...images[0]!, contentType: undefined },
  { ...images[0]!, contentType: "application/pdf" },
  { ...images[0]!, content: [{ type: "text" as const, text: "unsupported" }] },
])("rejects attachments outside the image subset", async (attachment) => {
  await expect(
    toPromptParts(
      { text: "", quote: undefined, attachments: [attachment] },
      vi.fn(),
    ),
  ).rejects.toThrow("Only image attachments are supported.");
});
