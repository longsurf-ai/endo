// Purpose: Locks wildcard matching and last-match permission precedence.

import { expect, test } from "vitest";
import { evaluate, match, merge } from "./rules";
import type { Ruleset } from "./types";

test.each([
  ["git", "git *", true],
  ["git status", "git *", true],
  ["github", "git *", false],
  ["a\nb", "a*b", true],
  ["src/a.ts", "src/?.ts", true],
  ["src/ab.ts", "src/?.ts", false],
  ["C:\\notes\\a.md", "C:/notes/*", true],
  ["a.b", "a.b", true],
  ["axb", "a.b", false],
  ["[a](b)+$^{}|", "[a](b)+$^{}|", true],
  ["before/read/after", "read", false],
])("matches %s against %s as %s", (input, pattern, expected) => {
  expect(match(input, pattern)).toBe(expected);
});

test("concatenates without mutation and chooses the last matching action/resource", () => {
  const defaults: Ruleset = [{ action: "*", resource: "*", decision: "deny" }];
  const override: Ruleset = [
    { action: "read", resource: "/notes/*", decision: "allow" },
  ];
  expect(evaluate("read", "/notes/a", defaults, override).decision).toBe(
    "allow",
  );
  expect(evaluate("read", "/notes/a", override, defaults).decision).toBe(
    "deny",
  );
  expect(evaluate("edit", "/notes/a", defaults, override).decision).toBe(
    "deny",
  );
  expect(evaluate("read", "/private/a", override).decision).toBe("ask");
  expect(merge(defaults, override)).toEqual([...defaults, ...override]);
  expect(defaults).toEqual([{ action: "*", resource: "*", decision: "deny" }]);
});
