// Purpose: Defines typed Effect failures owned by process-local event delivery.

import { Schema } from "effect";

/**
 * Explicit failure raised before a bounded subscriber can lose an event.
 *
 * @example
 * ```ts
 * const error = new SubscriberOverflowError({capacity: 256});
 * ```
 */
export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "Events.SubscriberOverflow",
  { capacity: Schema.Int },
) {}
