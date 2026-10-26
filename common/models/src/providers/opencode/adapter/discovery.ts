// Purpose: Reads policy-filtered native model choices without making an inference request.
import { z } from "zod";
import { AcpConnection, type AcpOptions } from "./acp";

const Session = z.looseObject({
  sessionId: z.string().min(1),
  configOptions: z.array(
    z.looseObject({
      id: z.string(),
      options: z
        .array(z.looseObject({ value: z.string().min(1), name: z.string() }))
        .optional(),
    }),
  ),
});

/** Native identity, display name and advertised efforts; other metadata remains unknown. */
export interface OpenCodeModel {
  id: string;
  name: string;
  availableVariants?: string[];
}

/**
 * Initializes a disposable ACP session in the explicit configuration directory.
 * Returns native model choices, including an empty configured catalog, without
 * prompting, signing in or installing. Deletes its disposable native session and
 * awaits process exit on success or failure. Native configuration is unchanged.
 * @example const models = await discoverModels({executable, cwd, env});
 */
export async function discoverModels(
  options: Pick<
    AcpOptions,
    "executable" | "cwd" | "env" | "signal" | "args" | "timeoutMs"
  >,
): Promise<OpenCodeModel[]> {
  const acp = new AcpConnection({
    ...options,
    notification: () => {},
    request: async () => {
      throw new Error("Discovery cannot approve native requests");
    },
  });
  let sessionId: string | undefined;
  try {
    const initialized = z.looseObject({ protocolVersion: z.literal(1) }).parse(
      await acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      }),
    );
    void initialized;
    const session = Session.parse(
      await acp.request("session/new", { cwd: options.cwd, mcpServers: [] }),
    );
    sessionId = session.sessionId;
    const model = session.configOptions.find((option) => option.id === "model");
    if (!model?.options)
      throw new Error("OpenCode did not return native model choices");
    const models = new Map<string, OpenCodeModel>();
    for (const option of model.options) {
      const selected = Session.omit({ sessionId: true }).parse(
        await acp.request("session/set_config_option", {
          sessionId,
          configId: "model",
          value: option.value,
        }),
      );
      const effort = selected.configOptions.find(
        (entry) => entry.id === "effort",
      );
      models.set(option.value, {
        id: option.value,
        name: option.name,
        availableVariants: (effort?.options ?? [])
          .map((entry) => entry.value)
          .filter((value) => value !== "default"),
      });
    }
    return [...models.values()];
  } finally {
    try {
      if (sessionId && !options.signal?.aborted)
        await acp.request("session/delete", { sessionId });
    } finally {
      await acp.close();
    }
  }
}
