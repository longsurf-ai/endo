// Purpose: Builds a request-only native agent overlay without rewriting user config or provider policies.
import { randomBytes } from "node:crypto";
import { z } from "zod";

const Inline = z.record(z.string(), z.unknown());

/**
 * Adds one unique native agent with Endo instructions and explicit model routing.
 * User inline settings remain intact; no provider policies or credentials are
 * generated. Malformed/non-JSON inherited inline content fails before I/O.
 * Config substitution syntax in instructions is escaped before native parsing.
 * @example const {env, agent} = requestEnvironment(process.env, modelId, system);
 */
export function requestEnvironment(
  inherited: NodeJS.ProcessEnv,
  modelId: string,
  system: string,
  permissionMode: "ask" | "auto" | "full-access" = "ask",
): { env: NodeJS.ProcessEnv; agent: string } {
  let inline: Record<string, unknown> = {};
  if (inherited.OPENCODE_CONFIG_CONTENT) {
    try {
      inline = Inline.parse(JSON.parse(inherited.OPENCODE_CONFIG_CONTENT));
    } catch (cause) {
      throw new Error(
        "Endo requires JSON in inherited OPENCODE_CONFIG_CONTENT to preserve its settings",
        { cause },
      );
    }
  }
  const agent = `endo_${randomBytes(12).toString("hex")}`;
  const agents = inline.agents === undefined ? {} : Inline.parse(inline.agents);
  const permissions =
    permissionMode === "auto"
      ? []
      : [{ action: "*", resource: "*", effect: "ask" }];
  // A dedicated agent ensures inherited primary-agent allows cannot bypass the
  // host callback. Native saved grants and managed restrictions still apply.
  const nativeAgent = { mode: "primary", system, model: modelId, permissions };
  const overlay = {
    ...inline,
    model: modelId,
    small_model: modelId,
    agents: { ...agents, [agent]: null },
  };
  // Encode only generated agent strings. Existing inline substitution syntax
  // remains OpenCode-owned; instructions cannot trigger file/environment reads.
  const encodedAgent = JSON.stringify(nativeAgent).replace(
    /\{(file|env):/g,
    "\\u007b$1:",
  );
  const content = JSON.stringify(overlay).replace(
    `"${agent}":null`,
    `"${agent}":${encodedAgent}`,
  );
  return { agent, env: { ...inherited, OPENCODE_CONFIG_CONTENT: content } };
}
