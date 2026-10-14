// Purpose: Registers the fixed OpenChart MCP relay and its allow rules in the Antigravity CLI's own configuration.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { HOST_SERVER, RELAY_PORT, RELAY_TOKEN } from "./host-tools";

/**
 * The CLI starts MCP servers from its global config and never expands
 * variables there, so one fixed bash relay reads them from the CLI's
 * environment instead. Without them, as in the user's own sessions, it exits.
 */
const RELAY = [
  `[ -n "$${RELAY_PORT}" ] || exit 0`,
  `exec 3<>"/dev/tcp/127.0.0.1/$${RELAY_PORT}" || exit 1`,
  `printf '%s\\n' "$${RELAY_TOKEN}" >&3`,
  "cat <&3 &",
  "exec cat >&3",
].join("\n");

/**
 * The `openchart` entry of `~/.gemini/config/mcp_config.json`. The CLI ends a
 * tool call after 3 minutes by default; OpenChart owns its tools' timeouts and
 * cancellation, and a call can wait on the user, so the CLI's deadline is only
 * a two-hour backstop.
 */
export const RELAY_SERVER = {
  command: "/bin/bash",
  args: ["-c", RELAY],
  timeoutSeconds: 2 * 60 * 60,
};

const McpConfig = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});
const CliSettings = z.looseObject({
  permissions: z
    .looseObject({ allow: z.array(z.string()).optional() })
    .optional(),
});

async function readJson(file: string): Promise<unknown> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
}

/** Replaces the file's target atomically, so a symlinked config stays linked. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const target = await fs.realpath(file).catch(() => file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, target);
}

/**
 * Lets the CLI reach OpenChart tools: the `openchart` MCP entry above, plus
 * allow rules for its tools and the schema files the CLI writes for them, so
 * headless runs without `--dangerously-skip-permissions` can call them. Only
 * missing or different values are written; everything else is preserved.
 * Invalid native JSON rejects instead of being overwritten.
 * @example await ensureHostToolConfig(os.homedir());
 */
export async function ensureHostToolConfig(home: string): Promise<void> {
  const mcpFile = path.join(home, ".gemini", "config", "mcp_config.json");
  const mcp = McpConfig.parse(await readJson(mcpFile));
  if (!isDeepStrictEqual(mcp.mcpServers?.[HOST_SERVER], RELAY_SERVER))
    await writeJson(mcpFile, {
      ...mcp,
      mcpServers: { ...mcp.mcpServers, [HOST_SERVER]: RELAY_SERVER },
    });

  const cli = path.join(home, ".gemini", "antigravity-cli");
  const settingsFile = path.join(cli, "settings.json");
  const settings = CliSettings.parse(await readJson(settingsFile));
  // The CLI checks resolved paths, e.g. /private/tmp rather than /tmp.
  const schemas = path.join(await fs.realpath(home), path.relative(home, cli));
  const rules = [
    `mcp(${HOST_SERVER}/*)`,
    `read_file(${path.join(schemas, "mcp", HOST_SERVER)}/)`,
  ];
  const allow = settings.permissions?.allow ?? [];
  const missing = rules.filter((rule) => !allow.includes(rule));
  if (missing.length > 0)
    await writeJson(settingsFile, {
      ...settings,
      permissions: { ...settings.permissions, allow: [...allow, ...missing] },
    });
}
