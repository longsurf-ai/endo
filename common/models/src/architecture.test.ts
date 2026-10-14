// Purpose: Enforces independent adapters, a provider-agnostic root, and the models package runtime boundary.
import { ANTIGRAVITY, CLAUDE_CODE, CODEX } from "@openchart/models/model-tiers";

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const providersDirectory = path.join(sourceDirectory, "providers");
const IMPORT = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)(['"])([^'"]+)\1/g;

async function productionSources(
  directory: string,
  recursive = true,
): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory())
        return recursive ? productionSources(filename) : [];
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [filename]
        : [];
    }),
  );
  return sources.flat();
}

async function violations(
  directory: string,
  recursive: boolean,
  violates: (filename: string, source: string, dependency: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  for (const filename of await productionSources(directory, recursive)) {
    const source = await fs.readFile(filename, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const dependency = match[2]!;
      if (violates(filename, source, dependency))
        found.push(
          `${path.relative(sourceDirectory, filename)}: ${dependency}`,
        );
    }
  }
  return found;
}

// Every owned adapter emits the shared protocol directly and reuse the shared
// continuation and generation helpers; everything else stays local.
const SHARED_DEPENDENCIES: readonly string[] = [
  "@openchart/models/provider-protocol",
  "@openchart/models/providers/continuation",
  "@openchart/models/providers/generate",
  "@openchart/utils/",
];

describe("models architecture", () => {
  it.each([CLAUDE_CODE, CODEX, ANTIGRAVITY])(
    "%s adapter owns its implementation without sibling or model-package dependencies",
    async (adapter) => {
      const directory = path.join(providersDirectory, adapter, "adapter");
      const self = `@openchart/models/providers/${adapter}/adapter`;
      const found = await violations(
        directory,
        true,
        (filename, _source, dependency) => {
          const outsidePackage =
            dependency.startsWith("@openchart/") &&
            dependency !== self &&
            !dependency.startsWith(`${self}/`) &&
            !SHARED_DEPENDENCIES.some((shared) =>
              dependency.startsWith(shared),
            );
          const outsideDirectory =
            dependency.startsWith(".") &&
            path
              .relative(
                directory,
                path.resolve(path.dirname(filename), dependency),
              )
              .startsWith("..");
          return outsidePackage || outsideDirectory;
        },
      );
      expect(found).toEqual([]);
    },
  );

  it("keeps root modules provider-agnostic; only providers/ names a native provider", async () => {
    const found = await violations(
      sourceDirectory,
      false,
      (_filename, _source, dependency) =>
        /^(?:\.\/providers|@openchart\/models\/providers)(?:\/|$)/.test(
          dependency,
        ),
    );
    for (const filename of await productionSources(sourceDirectory, false)) {
      if (path.basename(filename) === "model-tiers.ts") continue;
      if (
        /\b(?:CLAUDE_CODE|CODEX|ANTIGRAVITY)\b/.test(
          await fs.readFile(filename, "utf8"),
        )
      )
        found.push(`${path.relative(sourceDirectory, filename)}: provider ID`);
    }
    expect(found).toEqual([]);
  });

  it("keeps production modules independent of server, Effect, and Bun runtimes", async () => {
    const found = await violations(
      sourceDirectory,
      true,
      (_filename, _source, dependency) =>
        /^(?:@openchart\/server(?:\/|$)|effect(?:\/|$)|@effect\/|bun:)/.test(
          dependency,
        ),
    );
    for (const filename of await productionSources(sourceDirectory)) {
      if (/\bBun\./.test(await fs.readFile(filename, "utf8")))
        found.push(`${path.relative(sourceDirectory, filename)}: Bun runtime`);
    }
    expect(found).toEqual([]);
  });
});
