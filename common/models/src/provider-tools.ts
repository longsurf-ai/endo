// Purpose: Defines the host tool contract that provider-managed agent loops execute in-process.
import type { JSONSchema7 } from "@ai-sdk/provider";
import { fromJSONSchema, type ZodType } from "zod";

/** Identity of the model's call; adapters pass it so the host can correlate the outcome. */
export interface ProviderToolExecutionOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
}

/**
 * One OpenChart tool as a native agent loop sees it. The adapter runs
 * `execute` inside its own process when the native agent calls the tool, hands
 * the model only `toModelOutput(output)`, and emits the exact `output` on its
 * stream as the tool result, marked `toolExecution: "provider-mcp"`. Nothing is
 * restored later; the exact outcome never leaves the adapter's request.
 *
 * ```text
 * native agent -> adapter: execute(input) -> exact output -> stream tool-result
 *                                          -> toModelOutput() -> native agent
 * ```
 */
export type ProviderTools = Record<
  string,
  {
    description: string;
    inputSchema: ZodType;
    /** Runs the business action and returns its exact, opaque outcome. */
    execute(
      input: unknown,
      options: ProviderToolExecutionOptions,
    ): Promise<unknown>;
    /** Projects the exact outcome into the value the model reads. */
    toModelOutput(output: unknown): unknown;
  }
>;

/**
 * Adapts generated JSON Schema to the Zod input boundary native SDKs expect.
 * Application-specific decoding remains with the supplied tool executor.
 * @example const parameters = providerToolInputSchema({type: 'object', properties: {}});
 */
export function providerToolInputSchema(schema: JSONSchema7): ZodType {
  // The SDK and Zod describe the same JSON document with different dialect types.
  return fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0], {
    defaultTarget: "draft-7",
  });
}
