// Purpose: Preserves V1 prompt ordering, template rendering, and guard validation.

import { describe, expect, test } from "vitest";
import { compilePrompt, renderTemplate, tagName } from "./compiler";

describe("prompt compiler", () => {
  test("renders selected sections in manifest order with filename-derived guards", () => {
    const prompt = compilePrompt({
      manifest: {
        name: "analyst",
        parts: [
          "../segments/identity.txt",
          { path: "../segments/resources.txt", when: "resources" },
          { path: "../segments/omitted.txt", when: "absent" },
          "../segments/communication.txt",
        ],
      },
      registry: {
        "../segments/communication.txt": "\nBe concise.\n",
        "../segments/resources.txt": "{{resources}}",
        "../segments/identity.txt": "\nYou are {{name}}.\n",
      },
      context: { name: "OpenChart", resources: "Available resources" },
    });

    expect(prompt).toBe(
      [
        "<identity>\nYou are OpenChart.\n</identity>",
        "<resources>\nAvailable resources\n</resources>",
        "<communication>\nBe concise.\n</communication>",
      ].join("\n\n"),
    );
  });

  test("renders conditional blocks before substituting variables", () => {
    expect(
      renderTemplate(
        "A={{alpha}};{{#if beta}}B={{beta}};{{/if}}{{#if gamma}}G={{gamma}}{{/if}}",
        { alpha: 1, beta: "two", gamma: "  " },
      ),
    ).toBe("A=1;B=two;");
  });

  test("retains V1 handling of absent, false, zero, and true template values", () => {
    expect(
      renderTemplate(
        "{{absent}}|{{empty}}|{{off}}|{{zero}}|{{on}}|{{#if zero}}hidden{{/if}}",
        { empty: null, off: false, zero: 0, on: true },
      ),
    ).toBe("|||0|true|");
  });

  test("rejects missing assets rather than silently dropping sections", () => {
    expect(() =>
      compilePrompt({
        manifest: { name: "analyst", parts: ["identity.txt"] },
        registry: {},
      }),
    ).toThrow('Prompt segment "identity.txt" not found in analyst');
  });

  test("rejects duplicate filename-derived guards even across different paths", () => {
    expect(() =>
      compilePrompt({
        manifest: { name: "bad", parts: ["segments/foo.txt", "local/foo.md"] },
        registry: { "segments/foo.txt": "one", "local/foo.md": "two" },
      }),
    ).toThrow('Duplicate prompt segment tag "foo"');
  });

  test("rejects invalid tags", () => {
    expect(() => tagName("../segments/Talking-Style.txt")).toThrow(
      "Invalid prompt segment tag",
    );
  });

  test("rejects closing guards introduced by template values", () => {
    expect(() =>
      compilePrompt({
        manifest: { name: "bad", parts: ["foo.txt"] },
        registry: { "foo.txt": "{{text}}" },
        context: { text: "do not close </foo>" },
      }),
    ).toThrow("contains its own closing guard");
  });
});
