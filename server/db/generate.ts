// Purpose: Generates the migration stream and fresh database from Resource-owned schemas.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { format, resolveConfig } from "prettier";

const serverRoot = path.resolve(import.meta.dirname, "..");
const databaseDirectory = import.meta.dirname;
const snapshotPath = path.join(databaseDirectory, "schema.json");
const migrationDirectory = path.join(databaseDirectory, "migration");
const registryPath = path.join(databaseDirectory, "migration.gen.ts");
const schemaPath = path.join(databaseDirectory, "schema.gen.ts");
const drizzleConfigPath = path.join(databaseDirectory, "drizzle.config.ts");
const drizzleBinary = path.join(
  serverRoot,
  "node_modules",
  ".bin",
  "drizzle-kit",
);
const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    name: { type: "string" },
    hints: { type: "string" },
  },
  strict: true,
});

if (args.values.check) {
  await check();
} else {
  await generate(args.values.name);
}

/**
 * Generates the next incremental migration and refreshes all derived database
 * artifacts from the Resource-owned Drizzle schemas.
 *
 * @remarks
 * Assumes `schema.json` represents the last generated schema state and the
 * migration directory is an immutable, timestamp-ordered history. The Drizzle
 * schema glob is assumed to include every Resource-owned table. Generation
 * writes at most one new migration, advances the snapshot only with that
 * migration, and always refreshes the full schema and migration registry.
 *
 * @param name - Optional suffix for the generated migration name.
 * @throws If Drizzle Kit fails, produces more than one migration, or would
 * overwrite an existing migration; filesystem and formatting failures also
 * propagate.
 */
async function generate(name: string | undefined): Promise<void> {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "openchart-v2-migration-"),
  );
  const incremental = path.join(temporary, "incremental");
  const full = path.join(temporary, "full");
  try {
    await fs.mkdir(path.join(incremental, "baseline"), { recursive: true });
    await fs.copyFile(
      snapshotPath,
      path.join(incremental, "baseline", "snapshot.json"),
    );
    await runDrizzle(temporary, incremental, name);

    const generated = await generatedMigrations(incremental);
    if (generated.length > 1) {
      throw new Error(
        `Expected at most one generated migration, found ${generated.length}.`,
      );
    }
    const migrationName = generated[0];
    if (migrationName) {
      await fs.mkdir(migrationDirectory, { recursive: true });
      const target = path.join(migrationDirectory, `${migrationName}.ts`);
      if (await exists(target)) {
        throw new Error(`Database migration already exists: ${migrationName}`);
      }
      const sql = await fs.readFile(
        path.join(incremental, migrationName, "migration.sql"),
        "utf8",
      );
      await fs.writeFile(
        target,
        await formatTypescript(renderMigration(migrationName, sql)),
      );
      await fs.copyFile(
        path.join(incremental, migrationName, "snapshot.json"),
        snapshotPath,
      );
    }

    await fs.mkdir(full);
    await runDrizzle(temporary, full, "schema");
    await fs.writeFile(
      schemaPath,
      await formatTypescript(renderSchema(await generatedSql(full))),
    );
    await fs.writeFile(
      registryPath,
      await formatTypescript(renderRegistry(await typescriptMigrations())),
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Verifies that resource schemas and checked-in database artifacts are in
 * sync without modifying those artifacts.
 *
 * @remarks
 * Assumes `schema.json` is the baseline for the next incremental diff and the
 * migration directory is the canonical ordered history. The check generates
 * only in a temporary directory; it does not open an application database or
 * validate its migration ledger.
 *
 * @throws If a resource schema has an ungenerated migration, `schema.gen.ts`
 * is stale, `migration.gen.ts` is stale, or Drizzle Kit, filesystem, or
 * formatting work fails.
 */
async function check(): Promise<void> {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "openchart-v2-migration-check-"),
  );
  const incremental = path.join(temporary, "incremental");
  const full = path.join(temporary, "full");
  try {
    await fs.mkdir(path.join(incremental, "baseline"), { recursive: true });
    await fs.copyFile(
      snapshotPath,
      path.join(incremental, "baseline", "snapshot.json"),
    );
    await runDrizzle(temporary, incremental);
    if ((await generatedMigrations(incremental)).length > 0) {
      throw new Error(
        "Resource schemas have an ungenerated migration. Run `just migration <name>` from v2/.",
      );
    }

    await fs.mkdir(full);
    await runDrizzle(temporary, full, "schema");
    const expectedSchema = await formatTypescript(
      renderSchema(await generatedSql(full)),
    );
    if ((await fs.readFile(schemaPath, "utf8")) !== expectedSchema) {
      throw new Error(
        "The generated full schema is stale. Run `just migration <name>` from v2/.",
      );
    }

    const expectedRegistry = await formatTypescript(
      renderRegistry(await typescriptMigrations()),
    );
    if ((await fs.readFile(registryPath, "utf8")) !== expectedRegistry) {
      throw new Error(
        "The generated migration registry is stale. Run `just migration <name>` from v2/.",
      );
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function runDrizzle(
  temporary: string,
  output: string,
  name?: string,
): Promise<void> {
  const config = path.join(temporary, `${path.basename(output)}.config.ts`);
  await fs.writeFile(
    config,
    `import config from ${JSON.stringify(pathToFileURL(drizzleConfigPath).href)}\n\nexport default {...config, out: ${JSON.stringify(output)}}\n`,
  );
  const drizzleArgs = ["generate", "--config", config];
  if (name) drizzleArgs.push("--name", name);
  if (args.values.hints && path.basename(output) === "incremental") {
    drizzleArgs.push("--hints", args.values.hints);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(drizzleBinary, drizzleArgs, {
      cwd: serverRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `drizzle-kit exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}`,
        ),
      );
    });
  });
}

async function generatedMigrations(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await exists(path.join(directory, entry.name, "migration.sql"))) {
      result.push(entry.name);
    }
  }
  return result.sort();
}

async function generatedSql(directory: string): Promise<string> {
  const generated = await generatedMigrations(directory);
  if (generated.length === 0) return "";
  if (generated.length !== 1) {
    throw new Error(
      `Expected at most one full-schema migration, found ${generated.length}.`,
    );
  }
  return fs.readFile(
    path.join(directory, generated[0]!, "migration.sql"),
    "utf8",
  );
}

async function typescriptMigrations(): Promise<MigrationSource[]> {
  const entries = await fs.readdir(migrationDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && /^\d{14}_.+\.ts$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const source = await fs.readFile(
        path.join(migrationDirectory, filename),
        "utf8",
      );
      return {
        id: path.basename(filename, ".ts"),
        filename,
        checksum: createHash("sha256").update(source).digest("hex"),
      };
    }),
  );
}

interface MigrationSource {
  readonly id: string;
  readonly filename: string;
  readonly checksum: string;
}

function renderMigration(name: string, sql: string): string {
  return `// Purpose: Applies the ${name} forward-only SQLite migration.\n\nimport {Effect} from 'effect'\nimport type {DatabaseMigration} from '../migration'\n\nconst migration: DatabaseMigration.Migration = {\n  id: ${JSON.stringify(name)},\n  /**\n   * Applies this migration inside the runner-owned transaction.\n   *\n   * @example\n   * \`\`\`ts\n   * yield* migration.up(transaction);\n   * \`\`\`\n   */\n  up(tx) {\n    return Effect.gen(function* () {\n${renderStatements(sql)}\n    })\n  },\n}\n\nexport default migration\n`;
}

function renderSchema(sql: string): string {
  return `// Purpose: Generated full SQLite schema used for fresh V2 databases.\n\nimport {Effect} from 'effect'\nimport type {DatabaseMigration} from './migration'\n\nconst schema: Omit<DatabaseMigration.Migration, 'id'> = {\n  /**\n   * Creates the complete current schema inside the runner-owned transaction.\n   *\n   * @example\n   * \`\`\`ts\n   * yield* schema.up(transaction);\n   * \`\`\`\n   */\n  up(tx) {\n    return Effect.gen(function* () {\n${renderStatements(sql)}\n    })\n  },\n}\n\nexport default schema\n`;
}

function renderStatements(sql: string): string {
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(renderRun);
  return statements.length > 0
    ? statements.join("\n")
    : "      void tx\n      yield* Effect.void";
}

function renderRun(statement: string): string {
  const lines = statement.replaceAll("\t", "  ").split("\n");
  if (lines.length === 1) {
    return `      yield* tx.run(${JSON.stringify(lines[0]!)})`;
  }
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`;
}

function escapeTemplate(line: string): string {
  return line
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
}

async function formatTypescript(input: string): Promise<string> {
  return format(input, {
    ...(await resolveConfig(schemaPath)),
    parser: "typescript",
    filepath: schemaPath,
  });
}

function renderRegistry(migrations: readonly MigrationSource[]): string {
  const entries = migrations
    .map(
      (migration) =>
        `  {\n    ...(await import('./migration/${migration.id}')).default,\n    filename: ${JSON.stringify(migration.filename)},\n    checksum: ${JSON.stringify(migration.checksum)},\n  },`,
    )
    .join("\n");
  return `// Purpose: Generated ordered registry for every V2 SQLite migration.\n\nimport type {DatabaseMigration} from './migration'\n\nexport const migrations = [\n${entries}\n] satisfies DatabaseMigration.RegisteredMigration[]\n`;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await fs.access(filename);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
