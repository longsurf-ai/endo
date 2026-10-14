// Purpose: Preserves positional, quoted, missing and raw argument semantics.
import { expect, test } from "vitest";
import { expandTemplate, formatRestArgument, hints } from "./template";

test.each([
  ["$1", "research Google in depth", "research Google in depth"],
  ["$1|$2|$3", "one two rest of question", "one|two|rest of question"],
  [
    "$1|$2",
    '"first argument" "second argument" tail',
    "first argument|second argument tail",
  ],
  ["$1|$2", "'first argument' rest", "first argument|rest"],
  ["$1|$2", "[Image 1] explain this", "[Image 1]|explain this"],
  ["$1|$2|$3", "one", "one||"],
  ["$2", "unused remaining text", "remaining text"],
  ["$2 $1 $2", "one two three", "two three one two three"],
  ["$ARGUMENTS", 'one  "two three"\nfour', 'one  "two three"\nfour'],
  ["Summarize", "hello world", "Summarize\n\nhello world"],
  ["  Summarize  ", "   ", "Summarize"],
])("expands %s with upstream semantics", (template, args, expected) => {
  expect(expandTemplate(template, args).expandedText).toBe(expected);
});

test("retains separate captured values for structured Part builders", () => {
  expect(
    expandTemplate("$1 $2", '4 "research Google" and its competitors'),
  ).toEqual({
    expandedText: "4 research Google and its competitors",
    captures: { $1: "4", $2: "research Google and its competitors" },
  });
  expect(hints("$2 $1 $2 $ARGUMENTS")).toEqual(["$1", "$2", "$ARGUMENTS"]);
});

test.each([
  "",
  " ",
  "  leading and trailing  ",
  "newlines\n\r\nand\ttabs",
  `Apple's "earnings"`,
  `' "`,
  "[Image 1] \\path\\résumé 👀",
])("restores a captured rest argument verbatim: %j", (text) => {
  const encoded = formatRestArgument(text);
  expect(encoded).toBeTypeOf("string");
  expect(expandTemplate("$1 $2", `3 ${encoded}`).captures.$2).toBe(text);
});

test("does not pretend adjacent quote kinds can be encoded by the upstream parser", () => {
  expect(formatRestArgument(`both'"quotes`)).toBeUndefined();
});
