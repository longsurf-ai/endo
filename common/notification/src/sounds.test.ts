// Purpose: Every shipped choice resolves to the recorded, non-silent native PCM asset.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { notificationSounds, notificationSoundIds } from "./sounds";

test("the catalog contains unique, hash-pinned PCM WAV files suitable for native notification playback", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as {
    sounds: { id: string; sha256: string }[];
  };
  expect(new Set(notificationSoundIds).size).toBe(notificationSoundIds.length);
  for (const sound of notificationSounds) {
    const bytes = readFileSync(new URL(sound.url));
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    expect(bytes.readUInt16LE(20)).toBe(1); // PCM
    expect(bytes.readUInt16LE(22)).toBe(1); // mono
    expect(bytes.readUInt32LE(24)).toBe(44100);
    expect(bytes.readUInt16LE(34)).toBe(16);
    const data = bytes.indexOf("data", 12);
    expect(data).toBeGreaterThan(12);
    const length = bytes.readUInt32LE(data + 4);
    expect(length / (44100 * 2)).toBeLessThan(30);
    expect(
      bytes
        .subarray(data + 8, data + 8 + length)
        .some((sample) => sample !== 0),
    ).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      manifest.sounds.find((item) => item.id === sound.id)?.sha256,
    );
  }
});
