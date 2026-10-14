// Purpose: Share the existing Agent with the application subtree.
import { createContext, useContext, type ReactNode } from "react";

import type { Agent } from "@openchart/app/lib/agent/use-agent";

const AgentContext = createContext<{
  agent: Agent;
} | null>(null);

/**
 * Shares one host-created Agent without creating state or observers.
 * The host owns their lifecycle; Query, SessionStore, and assistant-ui retain state.
 * @example <AgentProvider agent={agent}>{children}</AgentProvider>
 */
export function AgentProvider({
  agent,
  children,
}: {
  agent: Agent;
  children: ReactNode;
}) {
  return (
    <AgentContext.Provider value={{ agent }}>{children}</AgentContext.Provider>
  );
}

/**
 * Reads the shared Agent; throws outside AgentProvider.
 * @example const { agent } = useAgentContext();
 */
export function useAgentContext() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("useAgentContext requires AgentProvider");
  return context;
}
