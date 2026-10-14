// Purpose: Verifies distributed Resource schemas compile into every database artifact.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { check } from "prettier";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Generation and verification start four Drizzle CLI processes.
// Allow startup headroom alongside the concurrent suite on two-core CI runners.
test("compiles Resource schemas into migration, schema, and registry", async () => {
  const temporary = await mkdtemp(
    resolve(tmpdir(), "openchart-v2-schema-compiler-"),
  );
  temporaryDirectories.push(temporary);
  const server = resolve(temporary, "server");
  const agent = resolve(server, "agent");
  const framework = resolve(server, "lib/resource");
  const resource = resolve(server, "resources/example");
  const dataset = resolve(server, "data/providers/example/market/session");
  await Promise.all([
    mkdir(agent, { recursive: true }),
    mkdir(framework, { recursive: true }),
    mkdir(resource, { recursive: true }),
    mkdir(dataset, { recursive: true }),
  ]);
  // Mirror the real server layout: the checked-in snapshot already contains
  // every Resource table, so their schemas must be present or Drizzle Kit
  // sees a drop and stops for an interactive rename prompt. Resource schemas
  // import the envelope helpers through package exports.
  await cp(resolve(import.meta.dirname, ".."), resolve(server, "db"), {
    recursive: true,
  });
  await cp(
    resolve(import.meta.dirname, "../../package.json"),
    resolve(server, "package.json"),
  );
  await cp(resolve(import.meta.dirname, "../../agent"), agent, {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
  await cp(resolve(import.meta.dirname, "../../lib/resource"), framework, {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
  await cp(
    resolve(import.meta.dirname, "../../resources"),
    resolve(server, "resources"),
    {
      recursive: true,
      filter: (source) => !source.endsWith(".test.ts"),
    },
  );
  await symlink(
    resolve(import.meta.dirname, "../../node_modules"),
    resolve(server, "node_modules"),
  );
  await symlink(
    resolve(import.meta.dirname, "../../../node_modules"),
    resolve(temporary, "node_modules"),
  );
  // Prove that the generator reads its workspace policy, rather than hardcoded defaults.
  await writeFile(
    resolve(temporary, ".prettierrc.json"),
    '{"singleQuote": false, "tabWidth": 4}',
  );
  await writeFile(
    resolve(resource, "schema.ts"),
    [
      "// Purpose: Defines a temporary compiler-test table.",
      "",
      "import {sqliteTable, text} from 'drizzle-orm/sqlite-core';",
      "",
      "export const example = sqliteTable('example', {id: text().primaryKey()});",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(dataset, "schema.ts"),
    "import {sqliteTable, text} from 'drizzle-orm/sqlite-core';\n" +
      "export const local = sqliteTable('example_local_dataset', {id: text().primaryKey()});\n",
  );
  await execute(
    process.execPath,
    [
      "--experimental-strip-types",
      "db/generate.ts",
      "--name",
      "create_example",
      "--hints",
      JSON.stringify([
        { type: "create", kind: "table", entity: ["public", "example"] },
      ]),
    ],
    { cwd: server },
  );

  const migrationFiles = (await readdir(resolve(server, "db/migration")))
    .filter((filename) => /^\d{14}_create_example\.ts$/.test(filename))
    .sort();
  expect(migrationFiles).toHaveLength(1);
  const migrationFilename = migrationFiles[0]!;
  const migration = await readFile(
    resolve(server, "db/migration", migrationFilename),
    "utf8",
  );
  const schema = await readFile(resolve(server, "db/schema.gen.ts"), "utf8");
  const registry = await readFile(
    resolve(server, "db/migration.gen.ts"),
    "utf8",
  );
  const checksum = createHash("sha256").update(migration).digest("hex");

  expect(migration).toContain("CREATE TABLE");
  expect(migration).toContain("example");
  expect(schema).toContain("CREATE TABLE");
  expect(schema).toContain("example");
  expect(schema).not.toContain("example_local_dataset");
  expect(migration).not.toContain("example_local_dataset");
  expect(registry).toContain(migrationFilename);
  expect(registry).toContain(checksum);
  for (const source of [migration, schema, registry]) {
    expect(
      await check(source, {
        parser: "typescript",
        singleQuote: false,
        tabWidth: 4,
      }),
    ).toBe(true);
  }

  await execute(
    process.execPath,
    ["--experimental-strip-types", "db/generate.ts", "--check"],
    { cwd: server },
  );
}, 30_000);
