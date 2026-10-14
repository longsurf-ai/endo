// Purpose: Share one mounted file view's transport and theme with its Dockview panels.
import {
  createContext,
  useContext,
  type ReactNode,
  type MutableRefObject,
} from "react";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

export type WorkspaceContextValue = {
  transport: AppTransport;
  /** Each editor tab's current save, keyed by Dockview panel ID and removed on unmount. It resolves at once when there is nothing to save and rejects when the write fails. */
  saves: MutableRefObject<Map<string, () => Promise<void>>>;
  instanceId: string;
  /** Widgets may collapse the file panel; the full page keeps it open. */
  collapsible: boolean;
  dark: boolean;
  actions?: ReactNode;
  navigation?: ReactNode;
};
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
);
/** Read the containing file view; panels never own a second backend connection. @example const { transport } = useWorkspaceView(); */
export function useWorkspaceView() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace panel requires WorkspaceView");
  return value;
}
