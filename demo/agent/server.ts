// Purpose: Starts the real V2 Agent backend with an isolated demo database and tool approvals.

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequestHandler } from "@openchart/server";
import { makeRuntime } from "@openchart/server/runtime";
import writeWorkflowTypes from "@openchart/server/agent/workflow/generate-workflow-types";

const home = mkdtempSync(path.join(tmpdir(), "openchart-agui-demo-"));
const port = Number(process.env.OPENCHART_AGUI_DEMO_PORT ?? 43873);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error(
    "OPENCHART_AGUI_DEMO_PORT must be an integer from 1 to 65535",
  );

await writeWorkflowTypes();

const runtime = makeRuntime({
  home,
  models: {
    fetchEnabled: false,
    userAgent: "OpenChart/V2 AG-UI demo",
  },
  profiles: {
    agents: {
      analyst: {
        permission: [
          { action: "echo", resource: "*", decision: "ask" },
          { action: "workflow", resource: "*", decision: "ask" },
        ],
      },
    },
  },
});
try {
  await runtime.context();
} catch (error) {
  await runtime.dispose();
  throw error;
}
const server = createServer(createRequestHandler(runtime));
server.once("close", () => void runtime.dispose());

server.listen(port, "127.0.0.1", () => {
  console.log(`AG-UI backend: http://127.0.0.1:${port}/trpc`);
  console.log(`Demo home: ${home}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
