// Purpose: Keep first-launch onboarding separate from existing profile data.
import { temporaryHome } from "@openchart/server/home.test-utils";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { prepareOnboarding } from "../startup";

test("a new profile queues the agent-connection workflow", async () => {
  const preferences = await prepareOnboarding(temporaryHome());
  expect(Object.keys(preferences!)).toEqual(["local:onboarding"]);
  expect(JSON.parse(preferences!["local:onboarding"]!)).toEqual({
    state: { workflow: "starter" },
    version: 1,
  });
});

test("an existing database is never opened, changed or offered onboarding", async () => {
  const home = temporaryHome();
  const filename = join(home, "openchart.sqlite3");
  // An empty database still identifies an existing profile, as in OpenChart.
  await writeFile(filename, "");
  expect(await prepareOnboarding(home)).toBeUndefined();
  expect(await readFile(filename, "utf8")).toBe("");
});

test("filesystem failures are not mistaken for a new profile", async () => {
  const home = join(temporaryHome(), "not-a-directory");
  await writeFile(home, "existing file");
  await expect(prepareOnboarding(home)).rejects.toMatchObject({
    code: "ENOTDIR",
  });
});
