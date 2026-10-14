// Purpose: Own typed workspace lifecycle, filesystem and content-conflict failures.
import { Schema } from "effect";
import { WorkspaceId } from "@openchart/server/resources/workspace/entity";
import { Entry } from "./contract";

/** The registration no longer exists. */
export class WorkspaceUnknown extends Schema.TaggedError<WorkspaceUnknown>()(
  "WorkspaceUnknown",
  { workspaceId: WorkspaceId },
) {}
/** This acquired instance has been retired. */
export class WorkspaceClosed extends Schema.TaggedError<WorkspaceClosed>()(
  "WorkspaceClosed",
  { workspaceId: WorkspaceId },
) {}
/** The registered physical directory is currently absent. */
export class WorkspaceMissing extends Schema.TaggedError<WorkspaceMissing>()(
  "WorkspaceMissing",
  { workspaceId: WorkspaceId },
) {}
/** A path resolved through a link, outside the root, or to the wrong entry type. */
export class WorkspacePathInvalid extends Schema.TaggedError<WorkspacePathInvalid>()(
  "WorkspacePathInvalid",
  { workspaceId: WorkspaceId, path: Schema.String },
) {}
/** A built-in original cannot be edited, removed or renamed through the file API. */
export class WorkspaceFileProtected extends Schema.TaggedError<WorkspaceFileProtected>()(
  "WorkspaceFileProtected",
  { workspaceId: WorkspaceId, path: Schema.String },
) {}
/** A move would replace an existing file or folder; nothing changed. */
export class EntryExists extends Schema.TaggedError<EntryExists>()(
  "EntryExists",
  { workspaceId: WorkspaceId, path: Schema.String },
) {}
/** A requested artifact does not exist. */
export class EntryMissing extends Schema.TaggedError<EntryMissing>()(
  "EntryMissing",
  { workspaceId: WorkspaceId, path: Schema.String },
) {}
/** A file exceeds the owner's bounded-read limit; the file is preserved unchanged. */
export class WorkspaceMediaTooLarge extends Schema.TaggedError<WorkspaceMediaTooLarge>()(
  "WorkspaceMediaTooLarge",
  { workspaceId: WorkspaceId, path: Schema.String, maxBytes: Schema.Int },
) {}
/** Current disk content differs from the caller's expected hash. */
export class EntryStale extends Schema.TaggedError<EntryStale>()("EntryStale", {
  workspaceId: WorkspaceId,
  path: Schema.String,
  current: Schema.NullOr(Entry),
}) {}
/** Filesystem diagnostics remain local; transports expose a safe message. */
export class WorkspaceReadFailed extends Schema.TaggedError<WorkspaceReadFailed>()(
  "WorkspaceReadFailed",
  { workspaceId: WorkspaceId, path: Schema.String, cause: Schema.Defect() },
) {}
/** A filesystem mutation failed before its commit point. */
export class WorkspaceWriteFailed extends Schema.TaggedError<WorkspaceWriteFailed>()(
  "WorkspaceWriteFailed",
  { workspaceId: WorkspaceId, path: Schema.String, cause: Schema.Defect() },
) {}
