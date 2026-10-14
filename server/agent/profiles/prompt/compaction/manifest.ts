// Purpose: Ordered prompt segment manifest for the compaction agent.

/** Compaction's single prompt section, compiled with the shared XML guard semantics. */
export const compactionPromptManifest = {
  name: "compaction",
  parts: ["../segments/compaction.txt"],
} as const;
