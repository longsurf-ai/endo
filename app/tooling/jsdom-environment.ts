// Purpose: Keep Node Fetch and its cancellation primitives together in jsdom tests.
import { builtinEnvironments, type Environment } from "vitest/environments";

/** Supplies jsdom's DOM while retaining the native cancellation APIs used by Fetch. */
export default {
  name: "jsdom",
  transformMode: "web",
  /**
   * Captures Node's constructors before jsdom replaces browser globals.
   * The built-in environment retains ownership of setup and teardown.
   * @example
   * // vite.config.ts
   * test: { environment: './tooling/jsdom-environment.ts' }
   */
  async setup(global, options) {
    const { AbortController, AbortSignal } = global;
    // Node 25 predefines method-less localStorage/sessionStorage getters; vitest keeps
    // globals it finds, so remove them for jsdom to supply working ones.
    delete global.localStorage;
    delete global.sessionStorage;
    const environment = await builtinEnvironments.jsdom.setup(global, options);
    Object.assign(global, { AbortController, AbortSignal });
    return environment;
  },
} satisfies Environment;
