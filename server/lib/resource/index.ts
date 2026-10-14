// Purpose: Public surface of the Resource framework; it names no concrete resource.

/**
 * Defines, persists, and mutates Resources without business nouns.
 *
 * A resource folder supplies a complete entity schema and a store. This
 * package derives the writable value schema, the intrinsic transitions, and
 * the post-commit invalidation event. Resource schemas declare
 * their own tables using the shared envelope column and constraint helpers.
 * Each Resource supplies the store that maps those tables to its domain entity.
 *
 * @packageDocumentation
 */

export {
  isServerManaged,
  serverManaged,
  type ServerManaged,
  isListKey,
  listKey,
  type ListKey,
} from "./annotation";
export {
  deriveListSchema,
  type ListFields,
  type ListFilter,
} from "./list-schema";
export {
  type DefineResourceInput,
  type Entity,
  type Id,
  type PureCodec,
  type ResourceDefinition,
  type ResourceShape,
  STRICT_PARSE_OPTIONS,
  type EntityBody,
  type WritableEntityBody,
  defineResource,
} from "./definition";
export {
  deriveWriteShape,
  type WritableFields,
  type WritableSchema,
} from "./write-schema";
export {
  type EnvelopeFields,
  Revision,
  Timestamp,
  envelopeFields,
} from "./envelope";
export {
  resourceEnvelopeChecks,
  resourceEnvelopeColumns,
} from "./envelope-columns";
export {
  PatchRejected,
  ResourceNotFound,
  ResourceStateInvalid,
  RevisionConflict,
} from "./errors";
export {
  withInvariants,
  ResourceIssue,
  resourceIssues,
  type At,
  type Path,
  type Invariant,
  type InvariantContext,
  type InvariantExpectation,
  type InvariantFactory,
} from "./invariant";
export {
  Patch,
  PatchOperation,
  applyJsonPatch,
  pointerSegments,
} from "./patch";
export { ResourceChanged } from "./events";
export {
  type InsertInput,
  type Row,
  type SaveInput,
  type Store,
  type StoreBody,
  type StoreError,
  type Tx,
} from "./store";
export * as Transactor from "./transactor";
export * as Transition from "./transition";
export type { IntrinsicTransitions, PatchInput } from "./intrinsic-transitions";
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ListCursor,
  ListOrderBy,
  type ListPosition,
  type ListWindow,
  type ListPage,
} from "./pagination";
