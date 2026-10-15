// Purpose: Queue the copied onboarding workflow for a new local profile.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import view from "./view.json";

/**
 * Returns first-launch browser preferences only when the profile has no app
 * database, following OpenChart's first-run boundary. Call before starting the
 * backend, which creates the database. Existing profiles are never changed.
 * Reads metadata only and owns no persistent resources. Filesystem failures
 * other than a missing database propagate so startup can report them.
 * @example const initialLocalStorage = await prepareOnboarding(home);
 */
export async function prepareOnboarding(
  home: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    await lstat(join(home, "openchart.sqlite3"));
    return undefined;
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause;
  }
  return Object.fromEntries(
    Object.entries(view.localStorage).map(([key, value]) => [
      key,
      JSON.stringify(value),
    ]),
  );
}
