// Purpose: Treat absent Resources as a normal result without hiding request failures.

/**
 * Map a Resource RPC's NOT_FOUND rejection to null; rethrow every other failure
 * unchanged so Query retains its error and retry handling. Use as a Promise
 * catch handler for optional reads or deletion of an already-absent Resource.
 * Owns no cache, navigation, subscriptions or cleanup.
 * @example get.query({ id }).catch(missingResourceAsNull);
 */
export function missingResourceAsNull(error: unknown): null {
  if (
    error instanceof Error &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data &&
    error.data.code === "NOT_FOUND"
  )
    return null;
  throw error;
}
