// Purpose: Searches complete Resource entities across every page of the shared catalog.

import * as Tool from "@openchart/server/agent/tool/tool";
import {
  STRICT_PARSE_OPTIONS,
  type ResourceDefinition,
  Transactor,
} from "@openchart/server/lib/resource";
import { MAX_PAGE_SIZE } from "@openchart/server/lib/resource/pagination";
import { resources } from "@openchart/server/resources/catalog";
import { Effect, Schema } from "effect";
import { ask, parse, result } from "./resource-shared";

const Search = Schema.Struct({ query: Schema.NonEmptyString }).annotate({
  parseOptions: STRICT_PARSE_OPTIONS,
});

/** Searches every page of the same canonical entities returned by Resource reads.
 * @example
 * const tool = yield* Tool.init(yield* ResourceSearchTool);
 * const output = yield* tool.execute({query: 'Rates'}, context);
 */
export const ResourceSearchTool = Tool.define(
  "resource_search",
  Effect.succeed({
    description:
      "Search saved user data across every Resource using case-insensitive substring matching of complete JSON entities. Returns items containing resource and id; read a match for its current data. No ranking or snippets.",
    parameters: Search,
    execute: (input: typeof Search.Type, context: Tool.Context) =>
      result(
        "Search resources",
        Effect.gen(function* () {
          yield* ask(
            context,
            "resource_search",
            resources.map((resource) => resource.name),
            input,
          );
          const query = input.query.toLowerCase();
          const items: { resource: string; id: string }[] = [];
          // Each page has its own transaction; matches retain catalog and page order.
          for (const resource of resources) {
            const definition: ResourceDefinition = resource;
            let cursor: string | undefined;
            do {
              const input = yield* parse(definition.listSchema, {
                limit: MAX_PAGE_SIZE,
                ...(cursor === undefined ? {} : { cursor }),
              });
              const page = yield* Transactor.run(
                definition.transitions.list(input),
              );
              for (const entity of page.items) {
                if (JSON.stringify(entity).toLowerCase().includes(query)) {
                  items.push({ resource: definition.name, id: entity.id });
                }
              }
              cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
          }
          return { items };
        }),
      ),
  }),
);
