// Purpose: Apply the shared server error policy to tRPC failures and wire formatting.

import { failureFor, type Failure } from "@openchart/server/lib/errors";
import { TRPCError, type TRPCDefaultErrorShape } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";

/** Marks a failure already classified and reported at the tRPC boundary. */
class BoundaryError extends TRPCError {
  /**
   * Keeps the public description beside its server-only diagnostic cause.
   * @example
   * const error = new BoundaryError(failure, cause);
   */
  constructor(
    readonly failure: Failure,
    cause: unknown,
  ) {
    super({ code: failure.status, message: failure.message, cause });
  }
}

/**
 * Removes tRPC-owned wrappers, applies server policy once, and retains the
 * original domain failure as the local cause. Also handles input-parser wrappers.
 * @example
 * const result = await next();
 * if (!result.ok) throw boundaryError(result.error);
 */
export function boundaryError(error: TRPCError): BoundaryError {
  if (error instanceof BoundaryError) return error;
  if (error.cause instanceof TRPCError) return boundaryError(error.cause);
  const cause = error.cause ?? error;
  return new BoundaryError(failureFor(cause, error.code), cause);
}

/**
 * Formats already-classified failures, or catches transport/late subscription
 * failures that did not pass through procedure middleware. No server stack or
 * cause is included, in any environment or on any route.
 * @example
 * const errorFormatter = formatError;
 */
export function formatError({
  shape,
  error,
}: {
  shape: TRPCDefaultErrorShape;
  error: TRPCError;
}) {
  const safe = boundaryError(error);
  return {
    message: safe.message,
    code: TRPC_ERROR_CODES_BY_KEY[safe.code],
    data: {
      code: safe.code,
      httpStatus: getHTTPStatusCodeFromError(safe),
      path: shape.data.path,
      ...safe.failure.details,
    },
  };
}
