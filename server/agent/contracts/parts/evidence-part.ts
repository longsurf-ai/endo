// Purpose: Owns evidence transcript Parts, sources, and candidate content.

import { Schema, SchemaGetter, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical news feed publisher identity schema for agent transcript content. */
export const NewsFeedPublisherIdentitySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("publisher") })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("company"),
    displaySymbol: Schema.String.check(Schema.isMinLength(1)),
    assetClass: Schema.String.check(Schema.isMinLength(1)),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
]).annotate({ identifier: "NewsFeedPublisherIdentity" });
/** Parsed news feed publisher identity value. */
export type NewsFeedPublisherIdentity =
  typeof NewsFeedPublisherIdentitySchema.Type;

/** Canonical evidence id schema for agent transcript content. */
export const EvidenceIdSchema = Schema.String.check(
  Schema.isPattern(/^evd_[0-9A-Za-z]{14}$/),
).annotate({ identifier: "EvidenceId" });
/** Parsed evidence id value. */
export type EvidenceId = typeof EvidenceIdSchema.Type;

/** Canonical evidence block id schema for agent transcript content. */
export const EvidenceBlockIdSchema = Schema.String.check(
  Schema.isPattern(/^b[0-9]+$/),
).annotate({ identifier: "EvidenceBlockId" });
/** Parsed evidence block id value. */
export type EvidenceBlockId = typeof EvidenceBlockIdSchema.Type;

const HttpUrlSchema = Schema.URLFromString.pipe(
  Schema.decodeTo(Schema.flip(Schema.URLFromString)),
)
  .check(Schema.isMaxLength(4096))
  .check(
    Schema.makeFilter(
      (value) => value.startsWith("http://") || value.startsWith("https://"),
      {
        message: "Evidence URLs must use http or https",
      },
    ),
  );

/** Canonical web search evidence source schema for agent transcript content. */
export const WebSearchEvidenceSource = Schema.Struct({
  kind: Schema.Literal("web_search_result"),
  title: Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.trim()),
      encode: SchemaGetter.passthrough(),
    }),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(1000)),
  url: HttpUrlSchema,
  hostname: Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.trim()),
      encode: SchemaGetter.passthrough(),
    }),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(253)),
  faviconUrl: Schema.optional(HttpUrlSchema),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "WebSearchEvidenceSource" });

/** Canonical document evidence source schema for agent transcript content. */
export const DocumentEvidenceSource = Schema.Struct({
  kind: Schema.Literal("document"),
  documentID: Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.trim()),
      encode: SchemaGetter.passthrough(),
    }),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(512)),
  title: Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.trim()),
      encode: SchemaGetter.passthrough(),
    }),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(1000)),
  url: Schema.NullOr(HttpUrlSchema),
  publishedAt: Schema.DateTimeUtcFromString.pipe(
    Schema.decodeTo(Schema.flip(Schema.DateTimeUtcFromString)),
  ),
  publisher: Schema.Struct({
    id: Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.transform((value) => value.trim()),
        encode: SchemaGetter.passthrough(),
      }),
    )
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(512)),
    name: Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.transform((value) => value.trim()),
        encode: SchemaGetter.passthrough(),
      }),
    )
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(512)),
    homepageUrl: Schema.NullOr(HttpUrlSchema),
    identity: NewsFeedPublisherIdentitySchema,
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "DocumentEvidenceSource" });

/** Canonical evidence source schema for agent transcript content. */
export const EvidenceSource = Schema.Union([
  WebSearchEvidenceSource,
  DocumentEvidenceSource,
]).annotate({ identifier: "EvidenceSource" });
/** Parsed evidence source value. */
export type EvidenceSource = typeof EvidenceSource.Type;

/** Canonical evidence block kind schema for agent transcript content. */
export const EvidenceBlockKind = Schema.Literals([
  "snippet",
  "summary",
  "excerpt",
]).annotate({ identifier: "EvidenceBlockKind" });
/** Parsed evidence block kind value. */
export type EvidenceBlockKind = typeof EvidenceBlockKind.Type;

/** Canonical evidence block candidate schema for agent transcript content. */
export const EvidenceBlockCandidate = Schema.Struct({
  kind: EvidenceBlockKind,
  text: Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.trim()),
      encode: SchemaGetter.passthrough(),
    }),
  ).check(Schema.isMinLength(1)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "EvidenceBlockCandidate" });
/** Parsed evidence block candidate value. */
export type EvidenceBlockCandidate = typeof EvidenceBlockCandidate.Type;

/** Canonical evidence candidate schema for agent transcript content. */
export const EvidenceCandidate = Schema.Struct({
  source: EvidenceSource,
  blocks: Schema.Array(EvidenceBlockCandidate)
    .pipe(Schema.mutable)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(4)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "EvidenceCandidate" });
/** Parsed evidence candidate value. */
export type EvidenceCandidate = typeof EvidenceCandidate.Type;

/** Canonical evidence candidates schema for agent transcript content. */
export const EvidenceCandidates = Schema.Array(EvidenceCandidate)
  .pipe(Schema.mutable)
  .check(Schema.isMaxLength(100))
  .annotate({ identifier: "EvidenceCandidates" });
/** Parsed evidence candidates value. */
export type EvidenceCandidates = typeof EvidenceCandidates.Type;

/** Canonical evidence block schema for agent transcript content. */
export const EvidenceBlock = Schema.Struct({
  id: EvidenceBlockIdSchema,
  kind: EvidenceBlockKind,
  text: Schema.String.check(Schema.isMinLength(1)),
  truncated: Schema.Boolean,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "EvidenceBlock" });
/** Parsed evidence block value. */
export type EvidenceBlock = typeof EvidenceBlock.Type;

/** Canonical evidence part data schema for agent transcript content. */
export const EvidencePartData = Schema.Struct({
  evidenceID: EvidenceIdSchema,
  sourcePartID: Schema.String.check(Schema.isStartsWith("prt")),
  capturedAt: Schema.Finite.check(Schema.isInt()).check(
    Schema.isGreaterThanOrEqualTo(0),
  ),
  contentHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  source: EvidenceSource,
  blocks: Schema.Array(EvidenceBlock)
    .pipe(Schema.mutable)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(4)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** Canonical evidence part schema for agent transcript content. */
export const EvidencePart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("evidence"),
  ...EvidencePartData.fields,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "EvidencePart",
  });
/** Parsed evidence part value. */
export type EvidencePart = typeof EvidencePart.Type;
