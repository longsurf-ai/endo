// Purpose: Preserves native permission-mode inheritance at the SDK query boundary.
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Starts a query whose omitted permission mode is resolved by Claude Code.
 * Explicit permissionMode options still take precedence over native settings.
 * @example
 * const request = nativeQuery({prompt: 'Hello', options: {model: 'sonnet'}});
 * try { for await (const message of request) console.log(message.type); }
 * finally { request.close(); }
 */
export function nativeQuery(
  request: Parameters<typeof query>[0],
): ReturnType<typeof query> {
  // SDK 0.3.280 otherwise injects --permission-mode default, overriding
  // permissions.defaultMode. Its CLI-resolution switch exists at runtime but
  // is absent from the public declarations. Keep this version-specific bridge
  // here; request.test.ts verifies real SDK argv so upgrades cannot drop it silently.
  // https://github.com/anthropics/claude-agent-sdk-typescript/issues/230
  const options = { ...request.options, resolvePermissionModeInCli: true };
  return query({ ...request, options });
}
