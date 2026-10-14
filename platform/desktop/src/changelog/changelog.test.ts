// Purpose: Keep the bundled changelog in step with the desktop version and short enough to read.
import metadata from "@openchart/desktop/package.json" with { type: "json" };
import { expect, test } from "vitest";

import changelog from "./changelog.json" with { type: "json" };

/** Zero-pads each part so plain string comparison orders x.y.z versions. */
const order = (version: string) =>
  version
    .split(".")
    .map((part) => part.padStart(6, "0"))
    .join(".");

test("the newest entry is the version being packaged", () => {
  expect(changelog[0]?.version).toBe(metadata.version);
});

test("entries are newest first, dated, and concise", () => {
  for (const [index, entry] of changelog.entries()) {
    expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Date(entry.date).toISOString().slice(0, 10)).toBe(entry.date);
    expect(entry.items.length).toBeGreaterThanOrEqual(1);
    expect(entry.items.length).toBeLessThanOrEqual(6);
    for (const item of entry.items)
      expect(item.length).toBeLessThanOrEqual(120);
    const older = changelog[index + 1];
    if (!older) continue;
    expect(order(entry.version) > order(older.version)).toBe(true);
    expect(entry.date >= older.date).toBe(true);
  }
});
