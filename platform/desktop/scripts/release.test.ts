// Purpose: Publish a usable release directory only after Apple verifies both artifacts.
import { beforeEach, expect, test, vi } from "vitest";

const { run, writeFile, rename, rm } = vi.hoisted(() => ({
  run: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(() => {}, { [promisify.custom]: run }) };
});
vi.mock("node:fs", async () => {
  const { Readable } = await import("node:stream");
  return { createReadStream: () => Readable.from(["signed artifact"]) };
});
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}fixture`),
  symlink: vi.fn(),
  writeFile,
  rename,
  rm,
}));

import { createRelease, releaseBaseUrl } from "./release";

const credentials = {
  signingIdentity: "Developer ID Application: Example",
  notaryProfile: "test-notary",
};
beforeEach(() => {
  vi.clearAllMocks();
  run.mockImplementation(async (command: string, args: string[]) => ({
    stdout: command.endsWith("PlistBuddy")
      ? "0.1.1\n"
      : args[0] === "rev-parse"
        ? "commit-sha\n"
        : "",
    stderr: "",
  }));
});

test("release artifacts and manifest use Endo's independent feed after verification", async () => {
  await createRelease("/build/Endo.app", "0.1.1", credentials);
  expect(releaseBaseUrl).toBe(
    "https://downloads.longsurf.ai/endo/darwin/arm64",
  );
  expect(run).toHaveBeenCalledWith("codesign", [
    "--sign",
    credentials.signingIdentity,
    "--timestamp",
    expect.stringContaining("Endo-0.1.1-darwin-arm64.dmg"),
  ]);
  expect(run).toHaveBeenCalledWith(
    "xcrun",
    [
      "notarytool",
      "submit",
      expect.any(String),
      "--keychain-profile",
      "test-notary",
      "--wait",
    ],
    expect.any(Object),
  );
  const manifest = writeFile.mock.calls.find(([file]) =>
    file.endsWith("RELEASES.json"),
  )!;
  expect(JSON.parse(manifest[1])).toMatchObject({
    currentRelease: "0.1.1",
    releases: [
      {
        version: "0.1.1",
        updateTo: {
          name: "Endo 0.1.1",
          url: `${releaseBaseUrl}/Endo-0.1.1-darwin-arm64.zip`,
        },
      },
    ],
  });
  expect(writeFile).toHaveBeenCalledWith(
    expect.stringMatching(/\/SOURCE$/),
    "commit-sha\n",
  );
  expect(rename).toHaveBeenCalledOnce();
  expect(rename).toHaveBeenCalledWith(
    expect.stringContaining(".preparing-"),
    expect.stringMatching(/\/out\/release\/0\.1\.1$/),
  );
  const assessment = run.mock.calls.findIndex(
    ([command, args]) => command === "spctl" && args.includes("open"),
  );
  expect(run.mock.invocationCallOrder[assessment]).toBeLessThan(
    writeFile.mock.invocationCallOrder[0]!,
  );
  expect(rm).toHaveBeenCalledTimes(2);
});

test.each(["dirty source", "invalid app signature", "rejected installer"])(
  "refuses %s without exposing a release directory",
  async (failure) => {
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (command: string, args: string[]) => {
      if (failure === "dirty source" && args[0] === "status")
        return { stdout: " M source.ts\n" };
      if (
        failure === "invalid app signature" &&
        command === "codesign" &&
        args.includes("--verify")
      )
        throw new Error("invalid signature");
      if (
        failure === "rejected installer" &&
        command === "xcrun" &&
        args.includes("submit")
      )
        throw new Error("notarization rejected");
      return normal(command, args);
    });
    await expect(
      createRelease("/build/Endo.app", "0.1.1", credentials),
    ).rejects.toThrow();
    expect(rename).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    if (failure === "rejected installer") expect(rm).toHaveBeenCalledTimes(2);
  },
);

test("rejects mismatched versions before signing or creating downloads", async () => {
  await expect(
    createRelease("/build/Endo.app", "0.1.2", credentials),
  ).rejects.toThrow("does not match");
  expect(run).toHaveBeenCalledOnce();
  expect(rename).not.toHaveBeenCalled();
});
