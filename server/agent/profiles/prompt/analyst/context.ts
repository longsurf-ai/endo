// Purpose: Derives analyst Resource discovery from the server's sole catalog.

import { resources } from "@openchart/server/resources/catalog";

/** Startup prompt values describe only Resources registered in this server. */
export const analystPromptContext = {
  resources: resources
    .map(
      (resource) =>
        `- ${resource.name}${resource.readOnly ? " (read-only)" : ""}${resource.description ? `: ${resource.description}` : ""}`,
    )
    .join("\n"),
};
