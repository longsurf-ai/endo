// Purpose: Ordered prompt segment manifest for the title agent.

/** Title's single prompt section, compiled with the shared XML guard semantics. */
export const titlePromptManifest = {
  name: "title",
  parts: ["../segments/title.txt"],
} as const;
