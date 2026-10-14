// Purpose: Opt-in release validation against the actual pinned downloads, without inference or user credentials.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ANTIGRAVITY, CODEX, CLAUDE_CODE } from "@openchart/models/model-tiers";
import { NATIVE_PROVIDERS } from "@openchart/models/providers";
import { nativeQuery } from "@openchart/models/providers/claude-code/adapter/native-query";
import { createInstallations } from "./installation";
import { PROVIDER_MANIFEST } from "./manifest";

// Run with OPENCHART_VERIFY_PROVIDER_DOWNLOADS=1 just test-core server/models/onboarding/native-runtime.test.ts.
test.skipIf(process.env.OPENCHART_VERIFY_PROVIDER_DOWNLOADS !== "1")(
  "pinned native archives and packaged SDK speak the expected protocols",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "openchart-native-runtime-"),
    );
    try {
      for (const [key, folder] of [
        ["HOME", "home"],
        ["CODEX_HOME", "codex-auth"],
        ["CLAUDE_CONFIG_DIR", "claude-auth"],
      ]) {
        const target = path.join(directory, folder!);
        await mkdir(target);
        vi.stubEnv(key!, target);
      }
      // Keep developer API keys and access tokens out of the isolated subprocesses.
      for (const key of Object.keys(process.env)) {
        if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_|CODEX_(?!HOME))/.test(key))
          vi.stubEnv(key, undefined);
      }
      const installations = createInstallations(
        path.join(directory, "model-providers"),
      );
      // Antigravity has no Windows pin.
      const antigravity =
        PROVIDER_MANIFEST[ANTIGRAVITY][
          `${process.platform}-${process.arch}`
        ] !== undefined;
      for (const id of [
        CODEX,
        CLAUDE_CODE,
        ...(antigravity ? [ANTIGRAVITY] : []),
      ]) {
        await installations.install(
          id,
          AbortSignal.timeout(10 * 60 * 1000),
          () => {},
        );
        expect(await installations.installed(id)).toBe(true);
      }
      const catalog = { get: async () => ({}) };
      const codex = NATIVE_PROVIDERS[CODEX].createModelProvider(
        catalog,
        installations.executables[CODEX],
      );
      const claude = NATIVE_PROVIDERS[CLAUDE_CODE].createModelProvider(
        catalog,
        installations.executables[CLAUDE_CODE],
      );
      const agy = antigravity
        ? NATIVE_PROVIDERS[ANTIGRAVITY].createModelProvider(
            catalog,
            installations.executables[ANTIGRAVITY],
          )
        : undefined;
      try {
        expect((await codex.discover()).status).toBe("authentication_required");
        if (agy)
          expect((await agy.discover()).status).toBe("authentication_required");
        expect((await claude.discover()).status).toBe(
          "authentication_required",
        );
        let release!: () => void;
        const finished = new Promise<void>((resolve) => {
          release = resolve;
        });
        const query = nativeQuery({
          // eslint-disable-next-line require-yield -- Initialize without submitting a user message.
          prompt: (async function* (): AsyncGenerator<never> {
            await finished;
          })(),
          options: {
            pathToClaudeCodeExecutable: installations.executables[CLAUDE_CODE],
            cwd: directory,
            persistSession: false,
            env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
          },
        });
        try {
          expect((await query.supportedModels()).length).toBeGreaterThan(0);
        } finally {
          release();
          query.close();
        }
      } finally {
        await Promise.all([codex.dispose(), claude.dispose(), agy?.dispose()]);
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15 * 60 * 1000,
);
