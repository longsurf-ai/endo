// Purpose: Prevents SDK updates from drifting away from the app-owned native artifact pins.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { ANTIGRAVITY, CLAUDE_CODE } from "@openchart/models/model-tiers";
import { PROVIDER_MANIFEST } from "./manifest";

const Package = Schema.Struct({
  dependencies: Schema.Record(Schema.String, Schema.String),
});
const SDKPackage = Schema.Struct({
  version: Schema.String,
  claudeCodeVersion: Schema.String,
});

test("Claude SDK, Desktop staging and every native artifact use one paired release", async () => {
  const modelsURL = new URL(
    "../../../common/models/package.json",
    import.meta.url,
  );
  const desktopURL = new URL(
    "../../../platform/desktop/package.json",
    import.meta.url,
  );
  const models = Schema.decodeUnknownSync(Schema.fromJsonString(Package))(
    await readFile(modelsURL, "utf8"),
  );
  const desktop = Schema.decodeUnknownSync(Schema.fromJsonString(Package))(
    await readFile(desktopURL, "utf8"),
  );
  const require = createRequire(modelsURL);
  const sdkPath = path.join(
    path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
    "package.json",
  );
  const sdk = Schema.decodeUnknownSync(Schema.fromJsonString(SDKPackage))(
    await readFile(sdkPath, "utf8"),
  );
  expect(models.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(
    sdk.version,
  );
  expect(desktop.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(
    sdk.version,
  );
  for (const artifact of Object.values(PROVIDER_MANIFEST[CLAUDE_CODE])) {
    expect(artifact.version).toBe(sdk.claudeCodeVersion);
    expect(artifact.url).toMatch(
      new RegExp(`-${sdk.version.replaceAll(".", "\\.")}\\.tgz$`),
    );
  }
});

test("every Antigravity pin is one flat GitHub release", () => {
  const pins = Object.values(PROVIDER_MANIFEST[ANTIGRAVITY]);
  const versions = new Set(pins.map((pin) => pin.version));
  expect(versions.size).toBe(1);
  const [version] = versions;
  for (const pin of pins) {
    expect(pin).toMatchObject({ layout: "flat", executable: "antigravity" });
    expect(pin.url).toMatch(
      new RegExp(
        `^https://github\\.com/google-antigravity/antigravity-cli/releases/download/${version!.replaceAll(".", "\\.")}/agy_cli_[a-z0-9_]+\\.tar\\.gz$`,
      ),
    );
  }
});
