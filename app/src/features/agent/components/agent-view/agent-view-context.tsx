// Purpose: Share one view's transport, prompt choices, Session and panel navigation.
import { createContext, useContext } from "react";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import type {
  DigInInput,
  ModelSelection,
  SessionState,
} from "@openchart/app/lib/agent/client";

/** A local selection, optionally already bound to its persisted child. */
export type DigInTarget = {
  kind: "dig-in";
  input: DigInInput;
  childSessionID?: string;
  model?: ModelSelection;
  workspaceId?: string;
};

/** Identify a panel by its saved child or unsent selection. @example key={digInViewKey(target)} */
export function digInViewKey(target: DigInTarget) {
  const { partId, startOffset, endOffset } = target.input.selection;
  return target.childSessionID ?? `${partId}:${startOffset}:${endOffset}`;
}

/** A quote draft or an existing conversation; hosts choose where to display it. */
export type AgentPanelTarget =
  DigInTarget | { kind: "session"; sessionID: string; title: string };

type AgentViewContextValue = {
  transport: AppTransport;
  session: SessionState["session"] | undefined;
  model: ModelSelection | undefined;
  workspaceId?: string;
  pending: DigInTarget | undefined;
  onOpen: ((target: AgentPanelTarget) => void) | undefined;
};

const AgentViewContext = createContext<AgentViewContextValue | undefined>(
  undefined,
);
/** Bind selection and markers to their own mounted view. @example <AgentViewProvider value={value}>{children}</AgentViewProvider> */
export const AgentViewProvider = AgentViewContext.Provider;
/** Read this view's navigation and canonical parent anchors. @example const digIn = useAgentView(); */
export function useAgentView() {
  return useContext(AgentViewContext);
}
