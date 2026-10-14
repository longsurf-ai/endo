import { expect, test } from "vitest";
import { directiveFormatter } from "@openchart/app/lib/prompt-converter/directive-formatter";

test.each([
  "moving average.tea",
  "€ average [20].tea",
  "foo}bar.tea",
  "path\\name.tea",
  "line\nbreak.tea",
])("round-trips file identity and surrounding prose: %s", (label) => {
  const item = { type: "file", label, id: `/workspace/${label}` };
  const text = `Read ${directiveFormatter.serialize(item)} please.`;
  expect(directiveFormatter.parse(text)).toEqual([
    { kind: "text", text: "Read " },
    { kind: "mention", ...item },
    { kind: "text", text: " please." },
  ]);
});

test("plain paths and incomplete directives remain ordinary text", () => {
  const text = "/workspace/demo.tea and :file[unfinished";
  expect(directiveFormatter.parse(text)).toEqual([{ kind: "text", text }]);
});
