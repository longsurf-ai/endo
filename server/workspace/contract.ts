// Purpose: Own workspace file boundaries and their public snapshot shape.
import { extname } from "node:path";
import { Schema } from "effect";
import { WorkspaceId } from "@openchart/server/resources/workspace/entity";

/** Every Workspace read is bounded before reading; larger files stay on disk but are not indexed. */
export const WORKSPACE_MEDIA_MAX_BYTES = 32 * 1024 * 1024;

const assetTypes: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** Supported binary preview MIME type, derived from the filename. @example assetMediaType("chart.png"); */
export const assetMediaType = (path: string) => {
  const extension = extname(path).slice(1).toLowerCase();
  return Object.hasOwn(assetTypes, extension)
    ? assetTypes[extension]
    : undefined;
};

/** Non-hidden relative path inside one registered directory, for files or folders. */
export const RelativePath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !/[\\:\0]/.test(value) &&
      value
        .split("/")
        .every((part) => part.length > 0 && !part.startsWith(".")),
    {
      message:
        "Expected a relative path without empty or hidden segments, backslashes or colons",
    },
  ),
).pipe(Schema.brand("Workspace.RelativePath"));
/** Validated workspace-relative path; filesystem checks still reject symlinks. */
export type RelativePath = typeof RelativePath.Type;
/** A directory relative to the workspace; the empty string denotes its root. */
export const DirectoryPath = Schema.Union([Schema.Literal(""), RelativePath]);
export type DirectoryPath = typeof DirectoryPath.Type;
/** Portable file path inside one registered directory; any non-hidden file type. */
export const RelPath = RelativePath.pipe(Schema.brand("Workspace.RelPath"));
/** Validated relative artifact path. */
export type RelPath = typeof RelPath.Type;
/** Supported media artifact path; text source files are never accepted as media imports. */
export const MediaPath = RelPath.check(
  Schema.makeFilter((value) => assetMediaType(value) !== undefined, {
    message: "Expected an image, PDF, audio or video path",
  }),
);
export type MediaPath = typeof MediaPath.Type;

/** SHA-256 of the exact bytes read from disk. */
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
/** Rebuildable file metadata; contents always come from a fresh read. */
export const Entry = Schema.Struct({ path: RelPath, hash: Hash });
export type Entry = typeof Entry.Type;
/** A finite directory listing; file contents and hashes belong to reads. */
export const Snapshot = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    entries: Schema.Array(Schema.Struct({ path: RelPath })),
    directories: Schema.Array(RelativePath),
  }),
  Schema.Struct({ status: Schema.Literal("missing") }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.String,
  }),
]);
export type Snapshot = typeof Snapshot.Type;
/** Workspace identity accepted by file procedures. */
export const ByWorkspace = Schema.Struct({ workspaceId: WorkspaceId });
/** One directory listing. Reading it never traverses child directories. */
export const ListDirectoryInput = Schema.Struct({
  ...ByWorkspace.fields,
  path: DirectoryPath,
});
/** Consumers describe data interests; Workspace owns how they are observed. */
export const WorkspaceInterest = Schema.Struct({
  ...ByWorkspace.fields,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("directory"), path: DirectoryPath }),
    Schema.Struct({ kind: Schema.Literal("file"), path: RelPath }),
  ]),
});
export type WorkspaceInterest = typeof WorkspaceInterest.Type;
export type WatchTarget = WorkspaceInterest["target"];
/** One SSE subscription multiplexes all of a client's active data interests. */
export const WatchInput = Schema.Struct({
  interests: Schema.Array(WorkspaceInterest),
});
/** One folder: `mkdir` creates it with missing parents; `removeDirectory` deletes it. */
export const MkdirInput = Schema.Struct({
  ...ByWorkspace.fields,
  path: RelativePath,
});
/** One file reference; registration identity is independent of its relative path. */
export const ReadInput = Schema.Struct({
  ...ByWorkspace.fields,
  path: RelPath,
});
/** Null expected hash means create only if the target is absent. Media paths never take text. */
export const WriteInput = Schema.Struct({
  ...ReadInput.fields,
  text: Schema.String,
  expected: Schema.NullOr(Hash),
});
/** Removal uses a fresh content hash. */
export const RemoveInput = Schema.Struct({
  ...ReadInput.fields,
  expected: Hash,
});
/** Moves a file or folder within one workspace; never overwrites an existing entry. */
export const RenameInput = Schema.Struct({
  ...ByWorkspace.fields,
  from: RelativePath,
  to: RelativePath,
});
