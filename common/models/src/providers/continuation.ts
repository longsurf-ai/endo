// Purpose: Reuses a native conversation when a prompt only appends one user turn to a completed one.
import { createHash } from "node:crypto";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";

const CAPACITY = 1000;

function digest(messages: readonly unknown[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(messages, (_, value: unknown) =>
        value instanceof Uint8Array ? `bytes:${value.byteLength}` : value,
      ),
    )
    .digest("hex");
}

function lastUserIndex(prompt: LanguageModelV4Prompt, before: number): number {
  for (let index = before - 1; index >= 0; index -= 1)
    if (prompt[index]!.role === "user") return index;
  return -1;
}

/**
 * Shared by both native adapters. OpenChart's history is authoritative; a
 * remembered native ID (Codex thread, Claude session) is only a hint that the
 * provider already holds this conversation. A hit means the new prompt equals
 * the prompt that completed there, followed by that turn's own assistant output
 * and exactly one new user message. Edits, forks, provider switches, compaction
 * and configuration changes miss and start fresh. Host work after the last user
 * also starts fresh: the native conversation has not seen those messages.
 * Hits are consumed exclusively
 * so concurrent branches never share one native conversation.
 */
export interface Continuation {
  /** Consumes the native ID for an append-only prompt, or returns undefined. */
  take(
    prompt: LanguageModelV4Prompt,
    configuration: string,
  ): string | undefined;
  /** Remembers the native ID that completed this prompt. */
  keep(prompt: LanguageModelV4Prompt, configuration: string, id: string): void;
  clear(): void;
}

/**
 * @example
 * const continuation = createContinuation();
 * const threadId = continuation.take(prompt, configuration) ?? (await startThread());
 */
export function createContinuation(): Continuation {
  const ids = new Map<string, string>();
  const key = (
    prompt: LanguageModelV4Prompt,
    end: number,
    configuration: string,
  ) => `${configuration}\n${digest(prompt.slice(0, end + 1))}`;
  return {
    take(prompt, configuration) {
      const current = lastUserIndex(prompt, prompt.length);
      if (current !== prompt.length - 1) return undefined;
      const previous = lastUserIndex(prompt, current);
      if (previous < 0) return undefined;
      for (let index = previous + 1; index < current; index += 1) {
        const role = prompt[index]!.role;
        if (role !== "assistant" && role !== "tool") return undefined;
      }
      const entry = key(prompt, previous, configuration);
      const id = ids.get(entry);
      ids.delete(entry);
      return id;
    },
    keep(prompt, configuration, id) {
      const current = lastUserIndex(prompt, prompt.length);
      if (current < 0) return;
      const entry = key(prompt, current, configuration);
      ids.delete(entry);
      // Do not retain a hint keyed by a user prefix that omits replayed host work.
      if (current !== prompt.length - 1) return;
      ids.set(entry, id);
      if (ids.size > CAPACITY) ids.delete(ids.keys().next().value!);
    },
    clear() {
      ids.clear();
    },
  };
}
