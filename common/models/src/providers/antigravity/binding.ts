// Purpose: Antigravity as OpenChart's native provider: discovery, catalog enrichment, quota, sign-in, and request policy.
import type { ModelsDev } from "@openchart/models/catalog";
import type {
  AvailableModel,
  ModelProvider,
  ProviderDiscoveryResult,
} from "@openchart/models/model-provider";
import { ANTIGRAVITY, classifyModels } from "@openchart/models/model-tiers";
import type {
  NativeProvider,
  ProviderRequestContext,
} from "@openchart/models/native-provider";
import {
  ProviderQuota,
  type QuotaMeter,
} from "@openchart/models/provider-quota";
import { hasExecutable } from "@openchart/models/providers/executable";
import { catalogModelMetadata } from "@openchart/models/providers/model-catalog";
import { assertTrue } from "@openchart/utils/assert";
import {
  ANTIGRAVITY_PROVIDER,
  createAntigravityProvider,
  type AntigravityProvider,
  type AntigravityProviderOptions,
  type NativeModel,
  type NativeUsageReport,
} from "@openchart/models/providers/antigravity/adapter/index";
import { antigravityTiers } from "./tiers";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_ID = /^(.+)-(low|medium|high|xhigh|max)$/;
const EFFORT_NAME = / \((low|medium|high|xhigh|max)\)$/i;
/** Plan windows `/usage` reports; unknown windows stay unknown. */
const WINDOW_MINUTES: Readonly<Record<string, number>> = {
  "5h": 5 * 60,
  weekly: 7 * 24 * 60,
};
/** Catalog provider per native model family; exact IDs only. */
const CATALOG_PROVIDERS = [
  ["gemini-", "google"],
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
] as const;

/**
 * The CLI lists one row per model and effort (`gemini-3.1-pro-low`, "Gemini
 * 3.1 Pro (Low)") and accepts `--model gemini-3.1-pro --effort low`, so rows
 * merge into one model whose efforts are its variants, in effort order.
 */
function groupModels(rows: NativeModel[]) {
  const models = new Map<string, { name: string; variants: string[] }>();
  for (const row of rows) {
    const id = EFFORT_ID.exec(row.id);
    const effort =
      id && EFFORT_NAME.exec(row.name)?.[1]?.toLowerCase() === id[2]
        ? id[2]!
        : undefined;
    const base = effort ? id![1]! : row.id;
    const model = models.get(base) ?? {
      name: effort ? row.name.replace(EFFORT_NAME, "") : row.name,
      variants: [],
    };
    if (effort) model.variants.push(effort);
    models.set(base, model);
  }
  return [...models].map(([id, { name, variants }]) => ({
    id,
    name,
    variants: EFFORTS.filter((effort) => variants.includes(effort)),
  }));
}

function enrichModel(
  model: ReturnType<typeof groupModels>[number],
  catalog: ModelsDev.Model | undefined,
): AvailableModel {
  const metadata = catalogModelMetadata(catalog);
  return {
    ...metadata,
    kind: "language",
    providerID: ANTIGRAVITY,
    id: model.id,
    name: model.name,
    availableVariants: model.variants,
    capabilities: {
      ...metadata.capabilities,
      reasoning:
        model.variants.length > 0 ? true : metadata.capabilities.reasoning,
      // Headless turns accept text only.
      attachment: false,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
    },
  };
}

/** Each model group's buckets, shortest window first; usage is the used share. */
function translateUsage(report: NativeUsageReport): ProviderQuota {
  const meters: QuotaMeter[] = report.groups.flatMap((group) =>
    group.buckets
      .map((bucket) => ({ bucket, minutes: WINDOW_MINUTES[bucket.window] }))
      .sort(
        (left, right) =>
          (left.minutes ?? Infinity) - (right.minutes ?? Infinity),
      )
      .map(({ bucket, minutes }) => ({
        scope: { kind: "model" as const, name: group.name },
        ...(minutes && { window: { kind: "duration" as const, minutes } }),
        usage: {
          kind: "percent" as const,
          usedPercent: Math.max(0, (1 - bucket.remaining_fraction) * 100),
        },
        ...(bucket.reset_time && {
          resetsAt: new Date(bucket.reset_time).toISOString(),
        }),
      })),
  );
  return ProviderQuota.parse({ status: "ready", meters });
}

/** Runs the CLI, records its exit status, then ends the input feed so `script` can exit. */
const SIGN_IN_TURN = `"$AGY_EXECUTABLE" -p /usage; echo "$?" > "$AGY_STATUS"; kill "$AGY_FEEDER" 2>/dev/null`;
/** `script` arguments that run {@link SIGN_IN_TURN} in a pseudo-terminal. */
const SCRIPT_ARGS =
  process.platform === "darwin"
    ? `-q /dev/null /bin/sh -c '${SIGN_IN_TURN}'`
    : `-q -c '${SIGN_IN_TURN}' /dev/null`;

/**
 * The CLI signs in only from a terminal: it reads piped stdin as a prompt.
 * `script` gives it a pseudo-terminal, but rejects the socket the host passes
 * as stdin, so bash feeds it an anonymous pipe from `cat`. Linux `script`
 * waits for that pipe to close and then reports an unreliable status, so the
 * turn stops the feed itself and bash exits with the CLI's recorded status.
 * `/usage` spends no model tokens and prints the plan once signed in; the CLI
 * waits 60 seconds for the code.
 */
function signInCommand(
  executable: string,
): Extract<
  ProviderDiscoveryResult,
  { status: "authentication_required" }
>["login"] {
  return {
    executable: "/bin/bash",
    args: [
      "-c",
      [
        `export AGY_CLI_DISABLE_AUTO_UPDATE=true AGY_EXECUTABLE="$1" AGY_STATUS="$(mktemp)" || exit 1`,
        `exec 3< <(exec cat 2>/dev/null)`,
        `export AGY_FEEDER=$!`,
        `/usr/bin/script ${SCRIPT_ARGS} <&3 3<&-`,
        `status=$(cat "$AGY_STATUS"); rm -f "$AGY_STATUS"`,
        `exit "\${status:-1}"`,
      ].join("\n"),
      "antigravity-sign-in",
      executable,
    ],
  };
}

// @agent invariant: construction contains only stable binding policy. The
// reusable model handle is stateless and every run-scoped capability enters
// doStream through providerOptions.
/**
 * Creates a lazy binding with fixed CLI policy and instance-owned disposal.
 * `antigravity models` establishes sign-in and the model list; exact catalog
 * matches enrich metadata. Higher tiers come first, then mapping preference,
 * then unclassified native order. Construction performs no I/O; the host owns
 * installation.
 * @example
 * const binding = antigravity.createModelProvider(catalog, executable);
 * try {
 *   const available = await binding.discover();
 *   if (available.status === "ready") binding.sdk.languageModel(available.provider.models[0]!.id);
 * } finally { await binding.dispose(); }
 */
function createAntigravityModelProvider(
  catalog: ReturnType<typeof ModelsDev.create>,
  executable: string,
): ModelProvider {
  let sdk: AntigravityProvider | undefined;
  let disposal: Promise<void> | undefined;
  function assertActive() {
    if (disposal) throw new Error("Antigravity binding is disposed");
  }
  function getSDK(): AntigravityProvider {
    assertActive();
    if (sdk) return sdk;
    assertTrue(hasExecutable(executable), "Antigravity executable not found");
    return (sdk = createAntigravityProvider({
      executable,
      // The host pins the installed version; the CLI must not replace itself.
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    }));
  }

  return {
    id: ANTIGRAVITY,
    get sdk() {
      return getSDK();
    },
    async discover() {
      assertActive();
      if (!hasExecutable(executable)) return { status: "not_installed" };
      const native = await getSDK().discoverModels();
      assertActive();
      if (native === undefined)
        return {
          status: "authentication_required",
          login: signInCommand(executable),
        };
      const providers = await catalog.get();
      assertActive();
      const models = groupModels(native).map((model) => {
        const family = CATALOG_PROVIDERS.find(([prefix]) =>
          model.id.startsWith(prefix),
        );
        return enrichModel(
          model,
          family && providers[family[1]]?.models[model.id],
        );
      });
      return {
        status: "ready",
        provider: {
          id: ANTIGRAVITY,
          name: "Antigravity",
          models: classifyModels(antigravityTiers, models),
        },
      };
    },
    async readQuota() {
      assertActive();
      assertTrue(hasExecutable(executable), "Antigravity executable not found");
      const usage = await getSDK().readUsage();
      assertActive();
      assertTrue(usage !== undefined, "Antigravity is not signed in");
      return translateUsage(usage);
    },
    dispose: () => (disposal ??= sdk?.dispose() ?? Promise.resolve()),
  };
}

/**
 * Binds one call's cwd, OpenChart tools, and permission mode; never cache the
 * result. Headless turns cannot ask, so `ask` and `auto` deny native actions
 * the user has not pre-approved in the CLI, and native questions go
 * unanswered. OpenChart tools still apply the host's own policy when they run.
 * @example
 * const providerOptions = {[antigravity.sdkKey]: antigravity.requestOptions({cwd, tools, permissionMode, askPermission})};
 */
function antigravityRequestOptions({
  cwd,
  tools,
  permissionMode,
}: ProviderRequestContext): AntigravityProviderOptions {
  return { cwd, tools, skipPermissions: permissionMode === "full-access" };
}

/** The CLI requires an effort for models that list efforts; prefer medium, then high. */
function defaultOptions(model: AvailableModel): Record<string, unknown> {
  const variants = model.availableVariants ?? [];
  const effort =
    ["medium", "high"].find((name) => variants.includes(name)) ?? variants[0];
  return effort ? { effort } : {};
}

/**
 * Antigravity as OpenChart's native provider.
 * @example
 * const binding = antigravity.createModelProvider(catalog, executable);
 */
export const antigravity = {
  id: ANTIGRAVITY,
  sdkKey: ANTIGRAVITY_PROVIDER,
  createModelProvider: createAntigravityModelProvider,
  requestOptions: antigravityRequestOptions,
  defaultOptions,
} satisfies NativeProvider;
