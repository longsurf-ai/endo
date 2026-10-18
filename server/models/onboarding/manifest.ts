// Purpose: Pins the complete native runtime artifacts shipped with this app release.
import type { NativeProviderID } from "@openchart/models/model-tiers";

/** Immutable download contract; the artifact host is never an updater. */
export interface RuntimeArtifact {
  readonly version: string;
  readonly url: string;
  /** SRI `sha512-<base64>` of the downloaded archive. */
  readonly integrity: string;
  /**
   * Archive shape: `npm` tarballs keep every entry under `package/`, which
   * installation strips; `flat` release archives keep entries at the root.
   */
  readonly layout: "npm" | "flat";
  /** Path of the CLI inside the installed payload. */
  readonly executable: string;
  /**
   * Set when the archive ships the CLI compressed at `<executable>.br`, as
   * Grok's npm packages do for their postinstall script. Installation
   * decompresses it to `executable` and removes the compressed copy.
   */
  readonly compression?: "brotli";
}
/** App-pinned archives per runtime id and `<platform>-<arch>`. */
export type RuntimeManifest<Id extends string> = Readonly<
  Record<Id, Readonly<Record<string, RuntimeArtifact>>>
>;
/**
 * Platform-specific pins. Update Claude SDK dependencies together with its artifacts.
 * Antigravity publishes GitHub release archives; Windows ships zip archives and
 * sign-in needs a POSIX pseudo-terminal, so it has no Windows pin. Grok's npm
 * platform packages ship the CLI Brotli-compressed.
 */
export const PROVIDER_MANIFEST: RuntimeManifest<NativeProviderID> = {
  codex: {
    "darwin-arm64": {
      version: "0.159.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-darwin-arm64.tgz",
      integrity:
        "sha512-D1x+5n2y0TE43ERJs3CbBDRPLQl968hpqsInOwYNhfnTOTT53McpfFa6+VfPWwmPi0zW0aJ0C97K+6MhNHYe6A==",
      layout: "npm",
      executable: "vendor/aarch64-apple-darwin/bin/codex",
    },
    "darwin-x64": {
      version: "0.159.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-darwin-x64.tgz",
      integrity:
        "sha512-uNsvmDAYH2H7/uJi3NYtn0d+bpMHgovZyZwm62Q8q/cdd1rp5oEbk2Axe5pbyiWFwSpjdT6fbuY8gTdX2i7zjg==",
      layout: "npm",
      executable: "vendor/x86_64-apple-darwin/bin/codex",
    },
    "linux-arm64": {
      version: "0.159.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-linux-arm64.tgz",
      integrity:
        "sha512-cm7ihiXIZILGQPWgak3ApOcRZ6beupDNPHVAJ9CyHxZSQPsTy6CSYg1GYLVe2DlRUQYprnXHZceOgheXo0PvHA==",
      layout: "npm",
      executable: "vendor/aarch64-unknown-linux-musl/bin/codex",
    },
    "linux-x64": {
      version: "0.159.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-linux-x64.tgz",
      integrity:
        "sha512-7ks+EeQjX33wfJXbggseyF0CJRFVgzDHA6BzC7mJjFsJKmdAuOFWMFeMeZe8vL/G6xEpL29wOdwR85sK49F0iA==",
      layout: "npm",
      executable: "vendor/x86_64-unknown-linux-musl/bin/codex",
    },
    "win32-arm64": {
      version: "0.159.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-win32-arm64.tgz",
      integrity:
        "sha512-o4oHXi4IONlLyMRHOIxXTPG1OdbD7Pxmqd2AcYRWHXP1YjrdqdEQozqQLU05rdYGcfrwBwcBqPpGO9LLVHd0fg==",
      layout: "npm",
      executable: "vendor/aarch64-pc-windows-msvc/bin/codex.exe",
    },
    "win32-x64": {
      version: "0.159.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-win32-x64.tgz",
      integrity:
        "sha512-Fp+TghoUzxOguHj/WAxOIZCIJpTOb4pB9p90tf6+g2PSTWSCvqpawwxPmDuCMxKs8Sn1gO5zP621PoCkBt5cuQ==",
      layout: "npm",
      executable: "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    },
  },
  "claude-code": {
    "darwin-arm64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.284.tgz",
      integrity:
        "sha512-gKY9MUjY83398uCiPLHsd87kyzu7agIM7ApqWpJkpSINep6hxx4rNoR8bUbNWg49Aoe/PW/DJkQByAQuNzR9rg==",
      layout: "npm",
      executable: "claude",
    },
    "darwin-x64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-0.3.284.tgz",
      integrity:
        "sha512-P+q6Z7sKeYz99uE7RJc4au1IK+4SiWe69pyHY3QXMnjZq8hSFU/5Mo8iSurLk9jRlihsMltV1rLA5naouYyCAQ==",
      layout: "npm",
      executable: "claude",
    },
    "linux-arm64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.284.tgz",
      integrity:
        "sha512-LDpuYDaz+pCdG29iy1pw4P1D2YVtpZOb4rWOPxxSpg2fFyUeQ5WrfnuszOxhDWpNh1k1ekDiKm3A9OzGcrkdtA==",
      layout: "npm",
      executable: "claude",
    },
    "linux-x64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.284.tgz",
      integrity:
        "sha512-yGytBCCwJvWeg1FzFpgnLM9BOM2vKVExtv6pMJHMtF82J5yhKHcxodRaYlQVd/HzJJ2nruKb9EnrhRBZ//4yRw==",
      layout: "npm",
      executable: "claude",
    },
    "win32-arm64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-arm64/-/claude-agent-sdk-win32-arm64-0.3.284.tgz",
      integrity:
        "sha512-zOXkdPHhElyxyFJ6eY5R+YGUswqBDZ+ZHNaRmQGJ28RkQYgwG5imNy/nfFR+/CPGlMnH9ZzbGc2rKYApm1K4Tg==",
      layout: "npm",
      executable: "claude.exe",
    },
    "win32-x64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.284.tgz",
      integrity:
        "sha512-VGaFRDCOPloj5IjvJTyy5JsSl9sE2HR3W+A6f/cjgh23/7Y5vK7/ka+1JQD+AkoGO9tbHqP2O6god3IBrLvOaw==",
      layout: "npm",
      executable: "claude.exe",
    },
  },
  antigravity: {
    "darwin-arm64": {
      version: "1.3.6",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.3.6/agy_cli_mac_arm64.tar.gz",
      integrity:
        "sha512-Rzo0toXQoJ1IeQ6Lhrw+VF36uIn+DY/IHLfh/fwzb+eM5XAi47Q4x1TJPJz/6xP9vRd+UP3twIfVJzL6VHUYPw==",
      layout: "flat",
      executable: "antigravity",
    },
    "darwin-x64": {
      version: "1.3.6",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.3.6/agy_cli_mac_x64.tar.gz",
      integrity:
        "sha512-EX4yit+ttpp1QzU/6HtSdsAK4YnyuxmGjabmZyl8NcX2izU3o1Qotbn1rD/uQZKW2VR5kLJK+B5oSOape0qCXA==",
      layout: "flat",
      executable: "antigravity",
    },
    "linux-arm64": {
      version: "1.3.6",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.3.6/agy_cli_linux_arm64_musl.tar.gz",
      integrity:
        "sha512-tZIkXtneG700zPA6cDzu2uERmnxdCgbEyH/ST0xEFGJ7/jA/TDcjxUaJQU8w3XemkwoPKx8Vk/ThBiYfmKyUZA==",
      layout: "flat",
      executable: "antigravity",
    },
    "linux-x64": {
      version: "1.3.6",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.3.6/agy_cli_linux_x64_musl.tar.gz",
      integrity:
        "sha512-5q1tme9luYqSv2VA8OXaGGs8i/3pc3Qjy3g6TwXvV+rby/AuXa+l3mKVJHhU5KK9rEerYebX3YXbXrLY28DqOQ==",
      layout: "flat",
      executable: "antigravity",
    },
  },
  opencode: {
    "darwin-arm64": {
      version: "2.0.32",
      url: "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.0.32.tgz",
      integrity:
        "sha512-wASwXBsWaOAYcZrh4ZLl4oaVxPCUAGVb7zZvXBBF8TjWE4uWgY0D2tj6gn80JfcO3b/s9woM6dP/gKqYKK2EdQ==",
      layout: "npm",
      executable: "bin/opencode",
    },
  },
  grok: {
    "darwin-arm64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-1.0.62.tgz",
      integrity:
        "sha512-RSfT2HoNR9lN7ji6lR2HC9Sz0DJLKTCPRXGtQFL4XDmZU+SFLZ8DzKKbqIfS+odHVQ2FnSLaBGud8Os8ghYpdA==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "darwin-x64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-darwin-x64/-/grok-darwin-x64-1.0.62.tgz",
      integrity:
        "sha512-RrzCeHkEFkC7DhU2hTuMe3jKMaLqfFLaGAhUyVPvFOrdEJAehk20VF5M9VLISKVUQrQTO82gwqd/ib83Da+wtg==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "linux-arm64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-linux-arm64/-/grok-linux-arm64-1.0.62.tgz",
      integrity:
        "sha512-IyxJjZzL8joNPLw/qx9TN4zoSA0vgXIZbOLptadLrP3lOrUV5TzpYT/EwhM9GhHxQGmovrm9oJFbuB+WYeTujQ==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "linux-x64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-linux-x64/-/grok-linux-x64-1.0.62.tgz",
      integrity:
        "sha512-MsqDUf0rryWKchpO7TBFY/npVTKiBF/4zarOXzBOqd0YVpnSs9P0tZmZdXQ0o95s9e4FTvpy/CgUbuOsiqkyVA==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "win32-arm64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-win32-arm64/-/grok-win32-arm64-1.0.62.tgz",
      integrity:
        "sha512-X9lRub7ybnGGvtWd5FKO8z8YCQ4SrNRpFrjY2IwcVgbIguVr1VVeLskWwpvASC5cTe7NfMHAMlq8JIQ/NbuZig==",
      layout: "npm",
      executable: "bin/grok.exe",
      compression: "brotli",
    },
    "win32-x64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-win32-x64/-/grok-win32-x64-1.0.62.tgz",
      integrity:
        "sha512-y03RgVwg13rjXPTPVroDmAKP9H+gJK+2MC8xJgNKRw9aV3wS4eEMqWH3kUyxyBw93zlAPvDWCgSNmDg1j1d2Yw==",
      layout: "npm",
      executable: "bin/grok.exe",
      compression: "brotli",
    },
  },
};
