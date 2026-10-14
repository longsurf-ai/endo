// Purpose: Parses the Antigravity CLI's headless JSON output once at the process boundary.
import { z } from "zod";

/** Per-step token counts; `input_tokens` excludes cache reads and `output_tokens` includes thinking. */
export const NativeUsage = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  thinking_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
});
export type NativeUsage = z.infer<typeof NativeUsage>;

const ToolInfo = z.looseObject({
  name: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  error: z.looseObject({ type: z.string(), message: z.string() }).optional(),
});

const Subagent = z.looseObject({
  type_name: z.string().optional(),
  role: z.string().optional(),
  initial_prompt: z.string().optional(),
  conversation_id: z.string().optional(),
});

/**
 * One step transition or text delta. `state` is `ACTIVE` while running and a
 * terminal value (`DONE`, `ERROR`, ...) afterwards; `step_type` names the step
 * kind (`user_input`, `agent_response`, `tool`, `checkpoint`, ...).
 */
export const StepUpdate = z.looseObject({
  conversation_id: z.string(),
  step_index: z.number().int().nonnegative(),
  state: z.string(),
  step_type: z.string(),
  tool_name: z.string().optional(),
  text_delta: z.string().optional(),
  usage: NativeUsage.optional(),
  tool_info: ToolInfo.optional(),
  subagent_info: z.looseObject({ subagents: z.array(Subagent) }).optional(),
});
export type StepUpdate = z.infer<typeof StepUpdate>;

/**
 * Ends one turn; `usage` may be cumulative across a resumed conversation.
 * Headless turns cannot ask for permission: the first unapproved action ends
 * the turn, still `SUCCESS`, with that action listed in `denied_actions`.
 */
export const TurnResult = z.looseObject({
  conversation_id: z.string(),
  status: z.string(),
  response: z.string(),
  error: z.string().optional(),
  usage: NativeUsage,
  structured_output: z.unknown().optional(),
  denied_actions: z
    .array(z.looseObject({ action: z.string(), display_name: z.string() }))
    .optional(),
});
export type TurnResult = z.infer<typeof TurnResult>;

const KnownEvent = z.discriminatedUnion("event", [
  z.looseObject({ event: z.literal("init"), conversation_id: z.string() }),
  z.looseObject({ event: z.literal("step_update"), step_update: StepUpdate }),
  z.looseObject({ event: z.literal("result"), result: TurnResult }),
]);
/** Stream-json events the adapter consumes. */
export type NativeEvent = z.infer<typeof KnownEvent>;

const KNOWN = new Set(["init", "step_update", "result"]);

/**
 * Parses one stdout line. Unknown event kinds return undefined so newer CLIs
 * can add events; a malformed known event throws.
 * @example const event = parseEvent('{"event":"init","conversation_id":"c1","init":{}}');
 */
export function parseEvent(line: string): NativeEvent | undefined {
  const json: unknown = JSON.parse(line);
  const kind = (json as { event?: unknown } | null)?.event;
  if (typeof kind !== "string" || !KNOWN.has(kind)) return undefined;
  return KnownEvent.parse(json);
}

/** Plan meters from `/usage`: groups of models sharing 5-hour and weekly buckets. */
export const NativeUsageReport = z.looseObject({
  groups: z.array(
    z.looseObject({
      name: z.string(),
      buckets: z.array(
        z.looseObject({
          id: z.string(),
          window: z.string(),
          remaining_fraction: z.number(),
          reset_time: z.string().optional(),
        }),
      ),
    }),
  ),
});
export type NativeUsageReport = z.infer<typeof NativeUsageReport>;

/** `--output-format json` result of a slash command such as `/usage`. */
export const CommandResult = z.looseObject({
  status: z.string(),
  error: z.string().optional(),
  command: z.looseObject({ name: z.string(), data: z.unknown() }).optional(),
});
