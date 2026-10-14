// Purpose: Locks lazy catalog ownership and enrichment-only parsing at cache and download boundaries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { ModelsDev } from "./catalog";
const fixture = {
  openai: {
    models: {
      "catalog-model": {
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        limit: { context: 100_000, output: 16_000 },
      },
    },
  },
} satisfies Record<string, ModelsDev.Provider>;
let cacheDirectory: string;

beforeEach(async () => {
  cacheDirectory = await fs.mkdtemp(path.join(tmpdir(), "models-catalog-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await fs.rm(cacheDirectory, { recursive: true, force: true });
});

function createCatalog(options: Partial<ModelsDev.Options> = {}) {
  const catalog = ModelsDev.create({
    cacheDirectory,
    fetchEnabled: false,
    userAgent: "models-catalog-test",
    ...options,
  });
  return catalog;
}

describe("ModelsDev.create", () => {
  it("does not read files, fetch, or start a timer at construction", () => {
    const read = vi.spyOn(fs, "readFile");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers();

    createCatalog({ fetchEnabled: true });

    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parses the cached catalog once and keeps the parsed result local to its instance", async () => {
    await fs.writeFile(
      path.join(cacheDirectory, "models.json"),
      JSON.stringify(fixture),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const first = createCatalog();
    const second = createCatalog();

    const providers = await first.get();

    expect(providers).toEqual(fixture);
    expect(await first.get()).toBe(providers);
    expect(await second.get()).toEqual(providers);
    expect(await second.get()).not.toBe(providers);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid cached data and retries after the file is corrected", async () => {
    await fs.writeFile(
      path.join(cacheDirectory, "models.json"),
      JSON.stringify({ openai: { name: "Missing provider fields" } }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const catalog = createCatalog({ fetchEnabled: true });

    await expect(catalog.get()).rejects.toBeInstanceOf(ZodError);
    await fs.writeFile(
      path.join(cacheDirectory, "models.json"),
      JSON.stringify(fixture),
    );
    await expect(catalog.get()).resolves.toEqual(fixture);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["cache", "download"] as const)(
    "projects only enrichment fields from an upstream %s payload",
    async (source) => {
      const upstream = {
        openai: {
          ...fixture.openai,
          id: "openai",
          name: "Catalog provider",
          api: "https://example.com",
          env: ["PROVIDER_KEY"],
          npm: "unused-sdk",
          models: {
            "catalog-model": {
              ...fixture.openai.models["catalog-model"],
              id: "catalog-model",
              name: "Catalog model",
              family: "family",
              release_date: "2026-01-01",
              status: "deprecated",
              interleaved: true,
              options: { requestSetting: true },
              headers: { Authorization: "unused" },
              provider: { npm: "unused-sdk" },
              variants: { high: { effort: "high" } },
            },
          },
        },
      };
      if (source === "cache") {
        await fs.writeFile(
          path.join(cacheDirectory, "models.json"),
          JSON.stringify(upstream),
        );
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(upstream)),
      );
      const catalog = createCatalog({ fetchEnabled: source === "download" });
      expect(await catalog.get()).toEqual(fixture);
    },
  );

  it("does not fetch or start automatic refresh when configuration disables it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers();
    const catalog = createCatalog();

    await expect(catalog.get()).resolves.toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fetches and parses an uncached catalog when configuration enables it", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(fixture)));
    vi.stubGlobal("fetch", fetch);
    const catalog = createCatalog({ fetchEnabled: true });

    const providers = await catalog.get();

    expect(providers).toEqual(fixture);
    expect(await catalog.get()).toBe(providers);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://models.dev/api.json",
      expect.objectContaining({
        headers: { "User-Agent": "models-catalog-test" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      await fs.readFile(path.join(cacheDirectory, "models.json"), "utf8"),
    ).toBe(JSON.stringify(fixture));
  });

  it("keeps the loaded snapshot stable while a new instance reads the current cache", async () => {
    const filepath = path.join(cacheDirectory, "models.json");
    await fs.writeFile(filepath, JSON.stringify(fixture));
    const first = createCatalog();
    const original = await first.get();
    const changed = structuredClone(fixture);
    changed.openai.models["catalog-model"].limit.context = 200_000;
    await fs.writeFile(filepath, JSON.stringify(changed));

    expect(await first.get()).toBe(original);
    expect(await createCatalog().get()).toEqual(changed);
  });

  it("shares one in-flight fetch across concurrent lookups", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(fixture)));
    vi.stubGlobal("fetch", fetch);
    const catalog = createCatalog({ fetchEnabled: true });
    const [first, second] = await Promise.all([catalog.get(), catalog.get()]);

    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("shares a failed download, then retries on the next lookup and caches success", async () => {
    const failure = new Error("Temporary network failure");
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async () => Response.json(fixture));
    vi.stubGlobal("fetch", fetch);
    const catalog = createCatalog({ fetchEnabled: true });

    expect(await Promise.allSettled([catalog.get(), catalog.get()])).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(fetch).toHaveBeenCalledOnce();

    const [first, second] = await Promise.all([catalog.get(), catalog.get()]);
    expect(first).toEqual(fixture);
    expect(second).toBe(first);
    expect(await catalog.get()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { body: "unavailable", status: 503 },
    { body: "invalid JSON", status: 200 },
    { body: '{"bad": {}}', status: 200 },
  ])(
    "rejects invalid downloads without writing a cache: $body",
    async ({ body, status }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status })),
      );
      await expect(
        createCatalog({ fetchEnabled: true }).get(),
      ).rejects.toThrow();
      await expect(
        fs.readFile(path.join(cacheDirectory, "models.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
