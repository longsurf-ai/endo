// Purpose: Own the app's shared transport, subscriptions, and reconnect lifecycle.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  configQueryKey,
  subscribeConfigInvalidation,
} from "@openchart/app/lib/config/config";
import { subscribeResourceInvalidation } from "@openchart/app/lib/resource/invalidation";
import { subscribeWorkspaceInvalidation } from "@openchart/app/lib/workspace/workspace";
import {
  createTransport,
  type AppTransport,
  type BackendConnection,
} from "@openchart/app/lib/transport/transport";

/**
 * Mount once in the app layout to share transport across child routes.
 * `services` is undefined until the initial effect creates it. Event-stream
 * failures set `connectionError`; a ready frame clears it.
 * Reconnect replaces the transport and increments `attempt`, used as the consumer
 * remount key. Cleanup releases app observers and cached Config; durable backend
 * executions retain their independent lifetimes.
 * @example const { services, connectionError, attempt, reconnect } = useBackendConnection(connection);
 */
export function useBackendConnection(connection: BackendConnection) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<{
    connection: BackendConnection;
    attempt: number;
    transport: AppTransport;
  }>();
  const [connectionError, setConnectionError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const reportError = useCallback((error: unknown) => {
    setConnectionError(String(error));
  }, []);
  useEffect(() => {
    const transport = createTransport(connection);
    setConnectionError(undefined);
    const resources = subscribeResourceInvalidation(
      transport,
      queryClient,
      reportError,
    );
    const config = subscribeConfigInvalidation(
      transport,
      queryClient,
      reportError,
    );
    const workspaces = subscribeWorkspaceInvalidation(
      transport,
      queryClient,
      reportError,
    );
    const readiness = transport.events.subscribe({
      next: (frame) => {
        if (frame.kind === "ready") setConnectionError(undefined);
      },
      error: reportError,
    });
    setCurrent({ connection, attempt, transport });
    return () => {
      resources.unsubscribe();
      config.unsubscribe();
      workspaces.unsubscribe();
      readiness.unsubscribe();
      queryClient.removeQueries({ queryKey: configQueryKey });
    };
  }, [connection, queryClient, attempt, reportError]);
  return {
    services:
      current?.connection === connection && current.attempt === attempt
        ? current
        : undefined,
    connectionError,
    attempt,
    reconnect: () => setAttempt((value) => value + 1),
  };
}
