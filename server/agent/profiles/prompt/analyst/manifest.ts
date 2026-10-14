// Purpose: Selects the concise analyst instructions for implemented V2 capabilities.

/** Analyst sections; callable capabilities come from the live tool catalog. */
export const analystPromptManifest = {
  name: "analyst",
  parts: [
    "../segments/identity.txt",
    "../segments/communication.txt",
    "../segments/resources.txt",
    "../segments/schedules.txt",
  ],
} as const;
