// Purpose: Binds OpenCode's native catalog, configuration and request callbacks to Endo.
import { homedir } from "node:os";
import { z } from "zod";
import type { ModelsDev } from "@openchart/models/catalog";
import type {
  AvailableModel,
  ModelProvider,
} from "@openchart/models/model-provider";
import { OPENCODE } from "@openchart/models/model-tiers";
import type {
  NativeProvider,
  ProviderRequestContext,
} from "@openchart/models/native-provider";
import type { ProviderPermissionAsk } from "@openchart/models/provider-permission";
import type { ProviderQuestionAsk } from "@openchart/models/provider-question";
import { hasExecutable } from "@openchart/models/providers/executable";
import { catalogModelMetadata } from "@openchart/models/providers/model-catalog";
import {
  createOpenCodeProvider,
  OPENCODE_PROVIDER,
  type OpenCodeProvider,
  type OpenCodePermission,
  type OpenCodeProviderOptions,
  type OpenCodeAnswer,
} from "./adapter/index";

function createModelProvider(
  catalog: ReturnType<typeof ModelsDev.create>,
  executable: string,
): ModelProvider {
  let sdk: OpenCodeProvider | undefined;
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (closing) throw new Error("OpenCode binding is disposed");
  };
  const getSDK = () => {
    assertActive();
    if (!sdk) {
      if (!hasExecutable(executable))
        throw new Error("OpenCode executable not found");
      // Provider-wide menus reflect global configuration. Request cwd is checked
      // independently by the native session and never becomes a cached catalog.
      sdk = createOpenCodeProvider({
        executable,
        discoveryDirectory: homedir(),
      });
    }
    return sdk;
  };
  return {
    id: OPENCODE,
    get sdk() {
      return getSDK();
    },
    async discover() {
      assertActive();
      if (!hasExecutable(executable)) return { status: "not_installed" };
      const native = await getSDK().discoverModels();
      assertActive();
      const providers = await catalog.get();
      assertActive();
      const models = native.map((model): AvailableModel => {
        const separator = model.id.indexOf("/");
        const nativeProvider = model.id.slice(0, separator);
        const nativeID = model.id.slice(separator + 1);
        const metadata = catalogModelMetadata(
          separator > 0
            ? providers[nativeProvider]?.models[nativeID]
            : undefined,
        );
        return {
          ...metadata,
          kind: "language",
          providerID: OPENCODE,
          id: model.id,
          name: model.name,
          ...(model.availableVariants !== undefined
            ? { availableVariants: model.availableVariants }
            : {}),
          capabilities: {
            ...metadata.capabilities,
            attachment: false,
            input: {
              text: true,
              image: false,
              audio: false,
              video: false,
              pdf: false,
            },
            output: { text: true },
          },
        };
      });
      return {
        status: "ready",
        provider: { id: OPENCODE, name: "OpenCode", models },
      };
    },
    async readQuota() {
      assertActive();
      // OpenCode aggregates arbitrary native providers, not one account plan.
      // An empty meter list reports no known quota; it does not claim unlimited use.
      return { status: "ready", meters: [] };
    },
    dispose: () => (closing ??= sdk?.dispose() ?? Promise.resolve()),
  };
}

function approval(
  ask: ProviderPermissionAsk,
): OpenCodeProviderOptions["approve"] {
  return async (request: OpenCodePermission, signal) => {
    signal.throwIfAborted();
    const { input, kind, name } = request;
    const value = (key: string) =>
      typeof input[key] === "string" ? (input[key] as string) : undefined;
    const command =
      kind === "execute" ||
      name === "execute" ||
      name === "shell" ||
      name === "bash";
    const edit = ["edit", "delete", "move"].includes(kind);
    const permission = command
      ? "run_command"
      : edit
        ? "edit"
        : kind === "fetch"
          ? "web_fetch"
          : kind;
    const pattern = command
      ? (value("command") ?? value("code"))
      : (value("filePath") ??
        value("file_path") ??
        value("path") ??
        value("url"));
    try {
      await ask({
        permission,
        patterns: [pattern ?? name],
        metadata: { ...request },
        always: [pattern ?? name],
      });
      signal.throwIfAborted();
      return true;
    } catch {
      return false;
    }
  };
}

const Choice = z.looseObject({
  const: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const Values = z.looseObject({
  enum: z.array(z.string()).optional(),
  oneOf: z.array(Choice).optional(),
  anyOf: z.array(Choice).optional(),
});
const Field = Values.extend({
  type: z.enum(["string", "array"]),
  title: z.string().optional(),
  description: z.string().optional(),
  items: Values.optional(),
});

function answering(ask: ProviderQuestionAsk): OpenCodeAnswer {
  return async ({ message, requestedSchema }, signal) => {
    const schema = z
      .looseObject({
        type: z.literal("object"),
        properties: z.record(z.string(), Field),
      })
      .safeParse(requestedSchema);
    if (!schema.success) return undefined;
    const properties = schema.data.properties;
    const fields = Object.entries(properties).filter(
      ([key]) => !key.endsWith("_custom"),
    );
    const questions = fields.map(([id, field]) => {
      const values = field.type === "array" ? field.items : field;
      const choices =
        values?.oneOf ??
        values?.anyOf ??
        values?.enum?.map((value) => Choice.parse({ const: value }));
      return {
        id,
        header: field.title ?? "",
        question: field.description ?? field.title ?? message,
        options: (choices ?? []).map((choice) => ({
          label: choice.title ?? choice.const,
          description: choice.description ?? "",
        })),
        multiple: field.type === "array",
        allowFreeform:
          !choices?.length || properties[`${id}_custom`] !== undefined,
        secret: false,
      };
    });
    if (!questions.length) return undefined;
    const reply = await ask({ questions }, { signal });
    if (reply.type !== "answered") return undefined;
    const answer: Record<string, unknown> = {};
    for (const [id, field] of fields) {
      const values = field.type === "array" ? field.items : field;
      const choices =
        values?.oneOf ??
        values?.anyOf ??
        values?.enum?.map((value) => Choice.parse({ const: value }));
      const selected = reply.answers[id] ?? [];
      const known: string[] = [];
      const custom: string[] = [];
      for (const label of selected) {
        const option = choices?.find(
          (choice) => (choice.title ?? choice.const) === label,
        );
        if (option) known.push(option.const);
        else custom.push(label);
      }
      if (!choices?.length)
        answer[id] = field.type === "array" ? selected : (selected[0] ?? "");
      else {
        if (known.length)
          answer[id] = field.type === "array" ? known : known[0];
        if (custom.length && properties[`${id}_custom`])
          answer[`${id}_custom`] = custom.join(", ");
      }
    }
    return answer;
  };
}

/**
 * OpenCode's native harness integration. Native configuration and authentication
 * stay with OpenCode. Discovery performs no inference or login; arbitrary native
 * IDs remain explicit choices without guessed quality tiers. Each request owns
 * its tool, permission and question callbacks; disposal releases borrowed handles.
 * @example const binding = opencode.createModelProvider(catalog, executable);
 */
export const opencode = {
  id: OPENCODE,
  sdkKey: OPENCODE_PROVIDER,
  createModelProvider,
  requestOptions({
    cwd,
    tools,
    permissionMode,
    askPermission,
    askQuestion,
  }: ProviderRequestContext): OpenCodeProviderOptions {
    return {
      cwd,
      tools,
      permissionMode,
      approve: approval(askPermission),
      ...(askQuestion ? { answer: answering(askQuestion) } : {}),
    };
  },
} satisfies NativeProvider;
