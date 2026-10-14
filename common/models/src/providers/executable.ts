// Purpose: Checks only the executable selected by the host; never searches the user environment.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * Reports absence without hiding permission or filesystem errors.
 * @example if (hasExecutable(executable)) await discoverModels();
 */
export function hasExecutable(executable: string): boolean {
  if (!path.isAbsolute(executable))
    throw new Error("Provider executable must be an absolute managed path");
  try {
    if (!statSync(executable, { throwIfNoEntry: false })?.isFile())
      return false;
    accessSync(executable, constants.X_OK);
    return true;
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    )
      return false;
    throw cause;
  }
}
