// Purpose: Registers the three core Agent profiles and their local prompt assets.

import { analystPromptContext } from "./prompt/analyst/context";
import { analystPromptManifest } from "./prompt/analyst/manifest";
import { compactionPromptManifest } from "./prompt/compaction/manifest";
import { compilePrompt } from "./prompt/compiler";
import { promptSegmentRegistry } from "./prompt/segments/registry";
import { titlePromptManifest } from "./prompt/title/manifest";
import type { AgentProfile } from "./profile";

const titlePrompt = compilePrompt({
  manifest: titlePromptManifest,
  registry: promptSegmentRegistry,
});
const compactionPrompt = compilePrompt({
  manifest: compactionPromptManifest,
  registry: promptSegmentRegistry,
});

/**
 * Contributes the built-in definitions to the registry draft.
 * Analyst describes the implemented V2 tools and shared Resource catalog.
 * Analyst allows every listed built-in tool, Task included.
 * Other profiles deny tools.
 * Per-request tool execution bindings remain caller-owned.
 * @example
 * yield* profiles.transform(registerBuiltins);
 */
export function registerBuiltins(
  draft: AgentProfile.Draft,
  documentationDirectory?: string,
): void {
  draft.update("analyst", (info) => {
    info.description = "General-purpose assistant.";
    info.mode = "primary";
    info.prompt = compilePrompt({
      manifest: analystPromptManifest,
      registry: promptSegmentRegistry,
      context: { ...analystPromptContext, documentationDirectory },
    });
    info.permission.push(
      { action: "echo", resource: "*", decision: "allow" },
      { action: "workflow", resource: "*", decision: "allow" },
      { action: "task", resource: "*", decision: "allow" },
      { action: "resource_read", resource: "*", decision: "allow" },
      { action: "resource_search", resource: "*", decision: "allow" },
      { action: "resource_mutate", resource: "*", decision: "allow" },
      { action: "read_transcript", resource: "*", decision: "allow" },
      { action: "search_transcript", resource: "*", decision: "allow" },
      { action: "create_schedule", resource: "*", decision: "allow" },
    );
  });
  draft.update("title", (info) => {
    info.mode = "primary";
    info.hidden = true;
    info.prompt = titlePrompt;
  });
  draft.update("compaction", (info) => {
    info.mode = "primary";
    info.hidden = true;
    info.prompt = compactionPrompt;
  });
}
