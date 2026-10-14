// Purpose: Give runtime tests an isolated profile cleaned after their finalizers.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** Creates one test-owned home; runtime disposal must finish before test cleanup.
 * @example const runtime = makeRuntime({home: temporaryHome(), databasePath: ':memory:'});
 */
export function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openchart-test-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
