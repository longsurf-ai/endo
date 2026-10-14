// Purpose: Configure Vite for the Desktop renderer, shared by the development server and renderer builds.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { InlineConfig, Plugin } from "vite";

const require = createRequire(import.meta.url);
const directory = dirname(require.resolve("@openchart/desktop/package.json"));
const appDirectory = dirname(require.resolve("@openchart/app/package.json"));

/**
 * The shared app's Vite config with Desktop's native bootstrap injected as the page entry.
 * Builds fail when the bundle misses that entry or includes mock APIs or Helmet.
 * @example const server = await createServer({ ...rendererConfig(), server: { port: 43875 } });
 */
export function rendererConfig(): InlineConfig {
  const desktopEntry = join(directory, "src/renderer.tsx");
  const entryPlugin: Plugin = {
    name: "desktop-renderer-entry",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "script",
          attrs: { type: "module", src: `/@fs/${desktopEntry}` },
          injectTo: "body",
        },
      ],
    },
    generateBundle() {
      if (
        [...this.getModuleIds()].some(
          (id) =>
            id.includes("/src/testing/mocks/") ||
            id.includes("/node_modules/msw/") ||
            id.includes("/node_modules/react-helmet-async/"),
        )
      )
        this.error("Desktop renderer must not bundle mock APIs or Helmet");
      // @agent invariant: Every renderer build uses Desktop's native bootstrap.
      if (!this.getModuleInfo(desktopEntry))
        this.error("Desktop renderer must include its native bootstrap");
    },
  };
  return {
    root: appDirectory,
    configFile: join(appDirectory, "vite.config.ts"),
    base: "/",
    plugins: [entryPlugin],
    // index.html has no script tag, so the startup dependency scan must start from the
    // injected entry; otherwise lazily loaded editor dependencies are first optimized
    // mid-session and their stale imports fail with 504 "Outdated Optimize Dep".
    optimizeDeps: { entries: [desktopEntry] },
  };
}
