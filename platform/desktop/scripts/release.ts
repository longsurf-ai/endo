// Purpose: Turn a notarized app into installable downloads and Electron's static update feed.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

/** Static feed compiled into signed builds and written into release manifests. */
export const releaseBaseUrl = "https://downloads.longsurf.ai/endo/darwin/arm64";
/** Default release identity; its private key stays in the signing Mac's Keychain. */
export const signingIdentity = "Developer ID Application: Longsurf, Inc.";
const run = promisify(execFile);

/**
 * Creates versioned DMG/ZIP downloads, checksums, RELEASES.json and SOURCE (the
 * commit the release was built from, which publishing tags) in out/release.
 * Requires committed tracked files, a Developer ID-signed, stapled Apple Silicon
 * app and the supplied notarization Keychain profile. Throws on failed Apple
 * verification; the update feed is written only after both downloads pass
 * verification. Cleans temporary files on failure; completed artifacts persist.
 * @example await createRelease('/build/Endo.app', '0.1.1', { signingIdentity, notaryProfile: 'openchart-notary' });
 */
export async function createRelease(
  appPath: string,
  version: string,
  credentials: { signingIdentity: string; notaryProfile: string },
): Promise<void> {
  z.string()
    .regex(/^\d+\.\d+\.\d+$/)
    .parse(version);
  const { stdout: appVersion } = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(appPath, "Contents/Info.plist"),
  ]);
  if (appVersion.trim() !== version)
    throw new Error(
      `Packaged version ${appVersion.trim()} does not match release ${version}`,
    );
  // The published tag must name the exact source of these bytes.
  const repository = join(import.meta.dirname, "../../..");
  const { stdout: changes } = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: repository },
  );
  if (changes.trim())
    throw new Error("Commit the release source before building a release.");
  const { stdout: commit } = await run("git", ["rev-parse", "HEAD"], {
    cwd: repository,
  });
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
  await run("xcrun", ["stapler", "validate", appPath]);
  await run("spctl", ["--assess", "--type", "execute", appPath]);
  const releases = join(import.meta.dirname, "../out/release");
  await mkdir(releases, { recursive: true });
  const output = await mkdtemp(join(releases, ".preparing-"));
  const name = `Endo-${version}-darwin-arm64`;
  const zip = join(output, `${name}.zip`);
  const dmg = join(output, `${name}.dmg`);
  const volume = await mkdtemp(join(tmpdir(), "endo-installer-"));
  try {
    await run("ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      appPath,
      zip,
    ]);
    await run("ditto", [appPath, join(volume, "Endo.app")]);
    await symlink("/Applications", join(volume, "Applications"));
    await run("hdiutil", [
      "create",
      "-volname",
      "Endo",
      "-srcfolder",
      volume,
      "-format",
      "UDZO",
      "-ov",
      dmg,
    ]);
    await run("codesign", [
      "--sign",
      credentials.signingIdentity,
      "--timestamp",
      dmg,
    ]);
    console.log("Notarizing installer:", dmg);
    await run(
      "xcrun",
      [
        "notarytool",
        "submit",
        dmg,
        "--keychain-profile",
        credentials.notaryProfile,
        "--wait",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    await run("xcrun", ["stapler", "staple", dmg]);
    await run("xcrun", ["stapler", "validate", dmg]);
    await run("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      dmg,
    ]);
    const checksums: string[] = [];
    for (const extension of ["dmg", "zip"]) {
      const file = `${name}.${extension}`;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(output, file)))
        hash.update(chunk);
      checksums.push(`${hash.digest("hex")}  ${file}`);
    }
    await writeFile(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
    await writeFile(join(output, "SOURCE"), commit);
    await writeFile(
      join(output, "RELEASES.json"),
      JSON.stringify(
        {
          currentRelease: version,
          releases: [
            {
              version,
              updateTo: {
                version,
                name: `Endo ${version}`,
                notes: "",
                pub_date: new Date().toISOString(),
                url: `${releaseBaseUrl}/${name}.zip`,
              },
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    await rename(output, join(releases, version));
    console.log("Verified release downloads:", join(releases, version));
  } finally {
    await rm(volume, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}
