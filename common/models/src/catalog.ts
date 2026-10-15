// Purpose: Loads models.dev enrichment metadata without provider availability or request configuration.
// Module:  @openchart/models
/* eslint-disable @typescript-eslint/no-namespace -- Namespace exports are the intentional public API for this module. */
import fs from "node:fs/promises";
import path from "path";
import z from "zod";
import { lazy } from "@openchart/utils/lazy";

const MODELS_DEV_URL = "https://models.dev";

export namespace ModelsDev {
  /** Catalog fields consumed by enrichment; identities come from native discovery. */
  export const Model = z.object({
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean().default(false),
    tool_call: z.boolean(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
        tiers: z
          .array(
            z.object({
              input: z.number(),
              output: z.number(),
              cache_read: z.number().optional(),
              cache_write: z.number().optional(),
              tier: z.object({
                type: z.literal("context"),
                size: z.number().int().positive(),
              }),
            }),
          )
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
  });
  export type Model = z.infer<typeof Model>;

  /** Catalog provider bucket; outer record keys supply lookup identity. */
  export const Provider = z.object({
    models: z.record(z.string(), Model),
  });

  export type Provider = z.infer<typeof Provider>;

  const Catalog = z.record(z.string(), Provider);

  /** Storage and download options owned by the catalog's caller. */
  export interface Options {
    readonly cacheDirectory: string;
    readonly fetchEnabled: boolean;
    readonly userAgent: string;
  }

  /**
   * Loads one catalog snapshot from disk, downloading and caching it on a miss
   * when fetching is enabled. Concurrent reads share the load; failures are
   * propagated and cleared so the next read can retry. Construction performs no I/O.
   * @example
   * const catalog = ModelsDev.create({
   *   cacheDirectory: '/tmp/openchart-models',
   *   fetchEnabled: false,
   *   userAgent: 'Endo',
   * });
   * const providers = await catalog.get();
   */
  export function create(options: Options) {
    const filepath = path.join(options.cacheDirectory, "models.json");
    const load = async (): Promise<Record<string, Provider>> => {
      const cached = await fs
        .readFile(filepath, "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      if (cached !== undefined) return Catalog.parse(JSON.parse(cached));
      if (!options.fetchEnabled) return {};

      const response = await fetch(`${MODELS_DEV_URL}/api.json`, {
        headers: { "User-Agent": options.userAgent },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`models.dev returned HTTP ${response.status}`);
      const content = await response.text();
      const providers = Catalog.parse(JSON.parse(content));
      await fs.mkdir(options.cacheDirectory, { recursive: true });
      await fs.writeFile(filepath, content, "utf8");
      return providers;
    };
    const cached = lazy(() =>
      load().catch((error: unknown) => {
        cached.reset();
        throw error;
      }),
    );
    return { get: () => cached() };
  }
}
