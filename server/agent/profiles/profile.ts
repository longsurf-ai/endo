// Purpose: Owns Agent profile schemas, scoped registration, configuration, and lookup.

export * as AgentProfile from "./profile";

import * as Permission from "@openchart/server/agent/permission/types";
import { AgentPromptModel } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Context, Effect, Layer, Schema, Struct, Types } from "effect";

import { registerBuiltins } from "./builtin";
import { State } from "./state";

const NonblankString = Schema.String.check(Schema.isPattern(/\S/));

/** Default selection identity; declaring it does not register a profile. */
export const defaultName = "analyst";

/**
 * A resolved profile, with explicit visibility and permission policy.
 * Prompt text must contain non-whitespace content and is preserved verbatim.
 * Permission owns rule semantics; profile lookup never evaluates permissions.
 */
export const Info = Schema.Struct({
  name: NonblankString,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  prompt: NonblankString,
  options: Schema.Record(Schema.String, Schema.Unknown),
  temperature: Schema.optional(Schema.Finite),
  topP: Schema.optional(Schema.Finite),
  permission: Permission.Ruleset,
  /** Optional profile model preference; callers resolve the request model. */
  model: Schema.optional(
    AgentPromptModel.mapFields(Struct.omit(["selectedVariant"])),
  ),
  /** V1's independent variant preference; callers resolve its applicability. */
  selectedVariant: Schema.optional(Schema.String),
  steps: Schema.optional(
    Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
}).annotate({ identifier: "AgentProfile.Info" });
/** Resolved profile value derived from its canonical schema. */
export type Info = typeof Info.Type;

/** Per-profile configuration fields derive from Info; the catalog key owns its name. */
export const Override = Schema.Struct({
  ...Info.mapFields(Struct.omit(["name"])).mapFields(
    Struct.map(Schema.optional),
  ).fields,
  disabled: Schema.optional(Schema.Boolean),
});
/** Parsed overrides for one profile. */
export type Override = typeof Override.Type;

/** Explicit configuration supplied by composition, without file or environment reads. */
export const Configuration = Schema.Struct({
  /** Host-owned, version-matched documentation root readable by native file tools. */
  documentationDirectory: Schema.optional(NonblankString),
  default: Schema.optional(NonblankString),
  agents: Schema.optional(Schema.Record(NonblankString, Override)),
  permission: Schema.optional(Permission.Ruleset),
});
/** Parsed configuration for a profile service instance. */
export type Configuration = typeof Configuration.Type;

/** Request fields consumed by LLM; callers select the profile before streaming. */
export type RequestAgent = Pick<
  Info,
  "name" | "prompt" | "options" | "temperature" | "topP"
>;

type Data = {
  agents: Map<string, Types.DeepMutable<Info>>;
  default?: string;
};

/** Edits a private rebuild candidate; new profiles must receive a nonblank prompt. */
export interface Draft {
  /**
   * Lists the candidate profiles, including definitions from earlier contributions.
   * @example
   * for (const profile of draft.list()) draft.remove(profile.name);
   */
  readonly list: () => readonly Info[];
  /**
   * Reads a candidate by its exact registered name.
   * @example
   * const existing = draft.get('analyst');
   */
  readonly get: (name: string) => Info | undefined;
  /**
   * Sets or clears the preferred default; lookup still checks mode and visibility.
   * @example
   * draft.default('reviewer');
   */
  readonly default: (name: string | undefined) => void;
  /**
   * Creates or edits a candidate; its name remains the registration key.
   * New candidates have no usable prompt until a contribution supplies one.
   * @example
   * draft.update('reviewer', info => { info.prompt = 'Review carefully.'; });
   */
  readonly update: (
    name: string,
    fn: (info: Types.DeepMutable<Info>) => void,
  ) => void;
  /**
   * Removes a candidate without affecting earlier contribution definitions.
   * @example
   * draft.remove('title');
   */
  readonly remove: (name: string) => void;
}

/** Profile lookup and scoped updates. */
export interface Interface extends State.Transformable<Draft> {
  /**
   * Resolves an explicit name exactly, including hidden and subagent profiles.
   * An omitted name selects the default visible primary or all-mode profile,
   * returning undefined when none is available.
   * An unknown explicit name returns undefined, never the default profile.
   * @example
   * const profile = yield* profiles.resolve(input.agent);
   */
  readonly resolve: (name?: string) => Effect.Effect<Info | undefined>;

  /**
   * Lists all registered profiles, including hidden and subagent profiles.
   * Callers must not mutate the service's profile definitions.
   * @example
   * const available = yield* profiles.all();
   */
  readonly all: () => Effect.Effect<ReadonlyArray<Info>>;
}

/**
 * Injectable profile registry; its Layer owns built-ins and configuration.
 * @example
 * const profiles = yield* AgentProfile.Service;
 * const analyst = yield* profiles.resolve('analyst');
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/AgentProfile",
) {}

/**
 * Builds one registry with built-ins followed by explicit configuration overrides.
 * Construction performs no model discovery or permission evaluation. Invalid
 * configuration shapes fail the Layer; invalid completed profile drafts are defects.
 * @example
 * const profiles = AgentProfile.layer({
 *   agents: {title: {model: {providerID: CODEX, modelID: 'gpt-5.6-luna'}}},
 * });
 */
export function layer(configuration: Configuration) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const config =
        yield* Schema.decodeUnknownEffect(Configuration)(configuration);
      const state = State.create<Data, Draft>({
        initial: () => ({ agents: new Map() }),
        draft: (data) => ({
          list: () => Array.from(data.agents.values()),
          get: (name) => data.agents.get(name),
          default: (name) => {
            data.default = name;
          },
          update: (name, fn) => {
            // An incomplete prompt is private to this draft. Finalization must
            // validate every profile before any rebuilt state becomes visible.
            const current = data.agents.get(name) ?? {
              name,
              mode: "all",
              hidden: false,
              prompt: "",
              options: {},
              permission: [{ action: "*", resource: "*", decision: "deny" }],
            };
            if (!data.agents.has(name)) data.agents.set(name, current);
            fn(current);
            current.name = name;
          },
          remove: (name) => {
            data.agents.delete(name);
          },
        }),
        finalize: (draft) =>
          Effect.forEach(
            draft.list(),
            (info) => Schema.decodeUnknownEffect(Info)(info),
            { discard: true },
          ).pipe(Effect.orDie),
      });
      const selectable = (info: Info | undefined) =>
        info && info.mode !== "subagent" && !info.hidden ? info : undefined;
      const selectedDefault = () => {
        const data = state.get();
        const configured = data.default
          ? selectable(data.agents.get(data.default))
          : undefined;
        if (configured) return configured;
        const analyst = selectable(data.agents.get(defaultName));
        if (analyst) return analyst;
        return Array.from(data.agents.values()).find((info) =>
          selectable(info),
        );
      };
      const service = Service.of({
        transform: state.transform,
        reload: state.reload,
        resolve: Effect.fn("AgentProfile.resolve")((name?: string) =>
          Effect.sync(() =>
            name === undefined
              ? selectedDefault()
              : state.get().agents.get(name),
          ),
        ),
        all: Effect.fn("AgentProfile.all")(() =>
          Effect.sync(() => Array.from(state.get().agents.values())),
        ),
      });
      yield* State.batch(
        Effect.gen(function* () {
          yield* service.transform((draft) =>
            registerBuiltins(draft, config.documentationDirectory),
          );
          yield* service.transform((draft) =>
            applyConfiguration(draft, config),
          );
        }),
      );
      return service;
    }),
  );
}

/**
 * Supplies analyst, title, and compaction with their built-in defaults.
 * @example
 * const profile = yield* Service.use(profiles => profiles.resolve()).pipe(
 *   Effect.provide(AgentProfile.layerDefault),
 * );
 */
export const layerDefault = layer({});

function applyConfiguration(draft: Draft, config: Configuration): void {
  if (config.default !== undefined) draft.default(config.default);
  for (const current of draft.list()) {
    draft.update(current.name, (info) => {
      info.permission.push(
        ...(config.permission ?? []).map((rule) => ({ ...rule })),
      );
    });
  }
  for (const [name, item] of Object.entries(config.agents ?? {})) {
    if (item.disabled) {
      draft.remove(name);
      continue;
    }
    const exists = draft.get(name) !== undefined;
    draft.update(name, (info) => {
      if (!exists) {
        info.permission.push(
          ...(config.permission ?? []).map((rule) => ({ ...rule })),
        );
      }
      if (item.model !== undefined) info.model = { ...item.model };
      if (item.selectedVariant !== undefined)
        info.selectedVariant = item.selectedVariant;
      if (item.prompt !== undefined) info.prompt = item.prompt;
      if (item.description !== undefined) info.description = item.description;
      if (item.mode !== undefined) info.mode = item.mode;
      if (item.hidden !== undefined) info.hidden = item.hidden;
      if (item.steps !== undefined) info.steps = item.steps;
      if (item.temperature !== undefined) info.temperature = item.temperature;
      if (item.topP !== undefined) info.topP = item.topP;
      if (item.options !== undefined) Object.assign(info.options, item.options);
      if (item.permission !== undefined)
        info.permission.push(...item.permission.map((rule) => ({ ...rule })));
    });
  }
}
