// Purpose: Defines shared permission modes and the native approval callback.

/** Application modes translated to native policy by each provider binding. */
export const PROVIDER_PERMISSION_MODES = [
  "ask",
  "auto",
  "full-access",
] as const;

/** One permission choice captured for a complete provider request. */
export type ProviderPermissionMode = (typeof PROVIDER_PERMISSION_MODES)[number];

/**
 * Permission callback protocol owned by the self-contained models package.
 * Upper layers must provide an adapter to their own permission contracts and
 * execution runtime, keeping application policy outside models.
 */
export type ProviderPermissionAsk = (input: {
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
}) => Promise<void>;
