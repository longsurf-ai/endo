// Purpose: Exports the independently owned OpenCode native adapter.
export {
  createOpenCodeProvider,
  type OpenCodeProvider,
  type OpenCodeProviderSettings,
} from "./provider";
export {
  OPENCODE_PROVIDER,
  type OpenCodePermission,
  type OpenCodeProviderOptions,
} from "./language-model";

export type { OpenCodeForm, OpenCodeAnswer } from "./questions";
