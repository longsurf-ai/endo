// Purpose: Supply the host-owned, canonical application profile directory.

import { Context, Effect, FileSystem, Layer } from "effect";

/** Application files belong under this directory; hosts own profile selection. */
export class Home extends Context.Service<Home, { readonly root: string }>()(
  "@openchart/server/Home",
) {
  /**
   * Creates and resolves a profile directory before application services start.
   * The directory persists after disposal; filesystem failures abort startup.
   * @example const home = Home.layer('/tmp/openchart-test');
   */
  static readonly layer = (root: string) =>
    Layer.effect(
      Home,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(root, { recursive: true });
        return Home.of({ root: yield* fs.realPath(root) });
      }),
    );
}
