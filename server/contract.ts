// Purpose: Type-only server surface for tRPC clients; exports no runtime code.

/**
 * The one server surface the app may import.
 *
 * `@openchart/server/contract` is published under a `types`-only exports
 * condition, so JavaScript cannot load it. Clients derive command types from
 * AppRouter and Agent shared state from the existing server projection.
 * The generic event stream and native AG-UI state do not carry that application
 * type, so it is re-exported explicitly from its owner.
 * Any other app dependency on server is a boundary violation.
 *
 * @packageDocumentation
 */

export type { AppRouter } from "./index";
export type { AgentSessionState } from "./agent/publisher/agui/state";
