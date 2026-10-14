// Purpose: Defines branded identifier schemas and generates compact monotonic IDs across runtimes.

import { Schema } from "effect";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE62 = BigInt(BASE62_ALPHABET.length);
const TIMESTAMP_WIDTH = 8;
const RANDOM_WIDTH = 6;
const COUNTER_MULTIPLIER = 0x10;
const MAX_COUNTER = COUNTER_MULTIPLIER - 1;
const MAX_DESCENDING_VALUE = BASE62 ** BigInt(TIMESTAMP_WIDTH) - BigInt(1);

let lastTimestamp = 0;
let counter = 0;

/** A branded, prefix-checked identifier schema that can also mint new values. */
export interface IdSchema<Brand extends string = string> extends Schema.brand<
  Schema.String,
  Brand
> {
  /**
   * Mints a fresh identifier using this schema's prefix and ordering.
   * @example
   * const id = SessionId.create();
   */
  readonly create: () => Schema.brand<Schema.String, Brand>["Type"];
}

/**
 * Defines an identifier's prefix, brand, validation, and creation policy once.
 *
 * Domain owners choose their vocabulary; this module knows no domain prefixes.
 * Declaring a schema generates no identifier and reads no random bytes.
 *
 * @param prefix - Domain prefix such as `ses` or `dsh`, without the underscore.
 * @param brand - Type-level identity such as `Session.ID` or `Dashboard.ID`.
 * @param order - Lexical creation order; defaults to ascending.
 * @returns The branded schema with a zero-argument `create` constructor.
 *
 * @example
 * ```ts
 * const SessionId = defineId('ses', 'Session.ID', 'descending');
 * const id = SessionId.create();
 * ```
 */
export function defineId<
  const Prefix extends string,
  const Brand extends string,
>(
  prefix: Prefix,
  brand: Brand,
  order: "ascending" | "descending" = "ascending",
): IdSchema<Brand> {
  const schema = Schema.String.check(Schema.isStartsWith(`${prefix}_`)).pipe(
    Schema.brand(brand),
  );
  return Object.assign(schema, {
    create: () => schema.make(`${prefix}_${create(order === "descending")}`),
  });
}

/**
 * Creates a suffix whose lexical order follows creation order.
 *
 * @returns A fourteen-character Base62 identifier suffix.
 *
 * @example
 * ```ts
 * const id = `evt_${Identifier.ascending()}`;
 * ```
 */
export function ascending(): string {
  return create(false);
}

/**
 * Creates a suffix whose lexical order is the reverse of creation order.
 *
 * @returns A fourteen-character Base62 identifier suffix.
 *
 * @example
 * ```ts
 * const id = `ses_${Identifier.descending()}`;
 * ```
 */
export function descending(): string {
  return create(true);
}

/**
 * Creates one prefix-free identifier suffix at a chosen timestamp.
 *
 * The timestamp is clamped to the latest observed value. A four-bit logical
 * counter preserves ordering within one millisecond and advances the logical
 * millisecond after its fifteen usable values are exhausted.
 *
 * @param descendingOrder - Whether later identifiers sort before earlier ones.
 * @param timestamp - Unix epoch time in milliseconds; defaults to wall time.
 * @returns A fourteen-character Base62 identifier suffix.
 * @throws If the encoded timestamp exceeds the fixed eight-character range.
 *
 * @example
 * ```ts
 * const suffix = Identifier.create(false, 1_700_000_000_000);
 * ```
 */
export function create(
  descendingOrder: boolean,
  timestamp = Date.now(),
): string {
  let currentTimestamp = timestamp;

  if (currentTimestamp < lastTimestamp) {
    currentTimestamp = lastTimestamp;
  }

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    counter = 0;
  } else if (counter >= MAX_COUNTER) {
    lastTimestamp += 1;
    currentTimestamp = lastTimestamp;
    counter = 0;
  }
  counter += 1;

  const packed =
    BigInt(currentTimestamp) * BigInt(COUNTER_MULTIPLIER) + BigInt(counter);
  const timeValue = descendingOrder ? MAX_DESCENDING_VALUE - packed : packed;

  return (
    encodeBase62Fixed(timeValue, TIMESTAMP_WIDTH) + randomBase62(RANDOM_WIDTH)
  );
}

function randomBase62(length: number): string {
  let result = "";
  for (const byte of globalThis.crypto.getRandomValues(
    new Uint8Array(length),
  )) {
    result += BASE62_ALPHABET.charAt(byte % BASE62_ALPHABET.length);
  }
  return result;
}

function encodeBase62Fixed(value: bigint, width: number): string {
  if (value < 0) {
    throw new Error("Base62 encoding expects a non-negative value");
  }

  let remaining = value;
  let result = "";
  do {
    const digit = Number(remaining % BASE62);
    result = BASE62_ALPHABET.charAt(digit) + result;
    remaining /= BASE62;
  } while (remaining > 0);

  if (result.length > width) {
    throw new Error(
      `Base62 value ${value} does not fit in ${width} characters`,
    );
  }
  return result.padStart(width, "0");
}
