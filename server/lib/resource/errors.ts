// Purpose: Defines the typed Effect failures every Resource write can surface.

import { Schema } from "effect";

import { ResourceIssue } from "./invariant";

/**
 * The addressed entity does not exist for the caller.
 *
 * @example
 * ```ts
 * const error = new ResourceNotFound({resource: 'agent_schedule', id: 'ags_1'});
 * ```
 */
export class ResourceNotFound extends Schema.TaggedError<ResourceNotFound>()(
  "Resource.NotFound",
  { resource: Schema.String, id: Schema.String },
) {}

/**
 * The caller's `expectedRevision` no longer matches the stored entity.
 *
 * The caller must reread the entity and resend its change against the new
 * revision; the framework never applies a write to a state the caller has not
 * seen.
 *
 * @example
 * ```ts
 * const error = new RevisionConflict({
 *   resource: 'agent_schedule',
 *   id: 'ags_1',
 *   expected: 3,
 *   actual: 4,
 * });
 * ```
 */
export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()(
  "Resource.RevisionConflict",
  {
    resource: Schema.String,
    id: Schema.String,
    expected: Schema.Int,
    actual: Schema.Int,
  },
) {}

/**
 * A JSON Patch operation could not be applied.
 *
 * `index`, `op`, and `path` always name the failing operation.
 *
 * @example
 * ```ts
 * const error = new PatchRejected({
 *   index: 0,
 *   op: 'replace',
 *   path: '/missing',
 *   reason: 'OPERATION_PATH_UNRESOLVABLE',
 * });
 * ```
 */
export class PatchRejected extends Schema.TaggedError<PatchRejected>()(
  "Resource.PatchRejected",
  {
    index: Schema.Int,
    op: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * A candidate Resource value does not satisfy its write schema.
 *
 * This is a caller-correctable failure before saving. Invalid persisted state
 * remains a defect and must never be translated into this error.
 *
 * @example
 * ```ts
 * const error = new ResourceStateInvalid({
 *   resource: 'agent_schedule',
 *   reason: 'name must not be empty',
 *   issues: [{code: 'schema.invalid', path: '/name', message: 'name must not be empty'}],
 * });
 * ```
 */
export class ResourceStateInvalid extends Schema.TaggedError<ResourceStateInvalid>()(
  "Resource.StateInvalid",
  {
    resource: Schema.String,
    reason: Schema.String,
    issues: Schema.Array(ResourceIssue),
  },
) {}
