// Purpose: Runtime assertion helpers for enforcing impossible internal states
// Module:  @openchart/utils

export function assertTrue(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertExists<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
}

export function assertNotNull<T>(
  value: T,
  message: string,
): asserts value is Exclude<T, null> {
  if (value === null) throw new Error(message);
}

/**
 * Impossible internal state: throw immediately and loudly. Use where control
 * flow reaches a state the type system could not exclude — never collapse it
 * into `null`, `[]`, `{}`, `false`, or a default value.
 */
export function fatal(message: string): never {
  throw new Error(`Invariant violated: ${message}`);
}
