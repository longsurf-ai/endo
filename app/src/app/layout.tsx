// Purpose: Compose application navigation, feature surfaces, and one backend connection across routes.
import { useErrorToast } from "@openchart/app/hooks/use-error-toast";
import {
  AuiConfig,
  AuiProvider,
  ModelContextClient,
} from "@assistant-ui/react";
import { useState } from "react";
import { Outlet, useMatch, useNavigate, useParams } from "react-router";

import { useBackendConnection } from "@openchart/app/app/connection/use-backend-connection";
import { CopilotAgent } from "@openchart/app/app/agent/copilot-agent";
import {
  CopilotControlsProvider,
  type CopilotPrefill,
} from "@openchart/app/app/agent/copilot-controls";
import {
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from "@openchart/app/components/ui/sidebar";
import type { ListedSession } from "@openchart/app/lib/agent/client";
import { RenameSessionDialog } from "@openchart/app/features/agent/components/sessions/rename-session-dialog/rename-session-dialog";
import { useAgent } from "@openchart/app/lib/agent/use-agent";
import { AgentProvider } from "@openchart/app/lib/agent/provider";
import { useKeyboardShortcut } from "@openchart/app/hooks/use-keyboard-shortcut";
import { UnsavedChangesProvider } from "@openchart/app/lib/unsaved-changes/unsaved-changes";
import { WorkspaceFileNavigation } from "@openchart/app/lib/workspace/workspace";
import { WorkspaceFileMergeProvider } from "@openchart/app/app/workspace/workspace-file-merge";
import { ConfiguredTheme, type Theme } from "@openchart/app/lib/theme/theme";
import type {
  AppTransport,
  BackendConnection,
} from "@openchart/app/lib/transport/transport";

import { LeftSidebar } from "./left-sidebar";
import type { AppRouteContext } from "./route-context";
import "./layout.css";
import { useSidebarSort } from "@openchart/app/stores/sidebar";
import { OnboardingHost } from "./trellis/host";

function AppLayoutContent({
  transport,
  connectionError,
  reconnect,
}: {
  transport: AppTransport;
  connectionError?: string;
  reconnect: () => void;
}) {
  const newThreadRoute = useMatch("/app");
  const savedThreadRoute = useMatch("/app/sessions/:sessionId");
  const hasCopilot = !newThreadRoute && !savedThreadRoute;
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotSessionID, setCopilotSessionID] = useState<string>();
  const [copilotPrefill, setCopilotPrefill] = useState<CopilotPrefill>();
  const copilotVisible = hasCopilot && copilotOpen;
  const sessionOrderBy = useSidebarSort((state) => state.chats);
  const agent = useAgent({ transport, sessionOrderBy });
  const [renamingSession, setRenamingSession] = useState<ListedSession>();
  const { sessionId: activeSessionID } = useParams();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pageHidden = copilotVisible && isMobile;

  function selectSession(id: string) {
    void navigate(`/app/sessions/${encodeURIComponent(id)}`);
    setOpenMobile(false);
  }

  function newChat() {
    void navigate("/app");
    setOpenMobile(false);
  }

  useKeyboardShortcut({
    disabled: Boolean(renamingSession),
    bindings: {
      n: {
        action: newChat,
        allowRepeat: true,
      },
    },
  });
  const routeContext: AppRouteContext = {
    transport,
  };
  useErrorToast(connectionError, {
    id: "backend-connection",
    title: "Connection interrupted",
    retry: reconnect,
  });

  return (
    <AgentProvider agent={agent}>
      <UnsavedChangesProvider>
        <WorkspaceFileNavigation.Provider
          value={(file) => {
            void navigate(`/app/workspaces?${new URLSearchParams(file)}`);
          }}
        >
          <LeftSidebar
            chats={{
              active: activeSessionID,
              onSelect: selectSession,
              onRename: setRenamingSession,
            }}
            onCreateChat={newChat}
          />
          <SidebarInset hidden={pageHidden} className="[&[hidden]]:hidden">
            <CopilotControlsProvider
              value={
                hasCopilot
                  ? {
                      open: copilotOpen,
                      toggle: () => setCopilotOpen((value) => !value),
                      selectSession: (sessionID) => {
                        setCopilotPrefill(undefined);
                        setCopilotSessionID(sessionID);
                        setCopilotOpen(true);
                      },
                      prefill: (text) => {
                        setCopilotPrefill({ text });
                        setCopilotOpen(true);
                      },
                    }
                  : null
              }
            >
              <WorkspaceFileMergeProvider>
                <Outlet context={routeContext} />
              </WorkspaceFileMergeProvider>
            </CopilotControlsProvider>
          </SidebarInset>
          <CopilotAgent
            transport={transport}
            sessionID={copilotSessionID}
            prefill={copilotPrefill}
            onPrefillApplied={() => setCopilotPrefill(undefined)}
            onSelectSession={setCopilotSessionID}
            open={copilotVisible}
            onClose={() => setCopilotOpen(false)}
          />
          {renamingSession ? (
            <RenameSessionDialog
              key={renamingSession.id}
              session={renamingSession}
              onClose={() => setRenamingSession(undefined)}
            />
          ) : null}
          <OnboardingHost transport={transport} />
        </WorkspaceFileNavigation.Provider>
      </UnsavedChangesProvider>
    </AgentProvider>
  );
}

/** Keeps navigation and backend observation mounted across child routes. @example <Route element={<AppLayout connection={connection} />} /> */
export function AppLayout({
  connection,
  initialTheme = "system",
}: {
  connection: BackendConnection;
  initialTheme?: Theme;
}) {
  const { services, connectionError, attempt, reconnect } =
    useBackendConnection(connection);
  const context = AuiConfig({ modelContext: ModelContextClient() });
  return (
    <AuiProvider config={context}>
      <SidebarProvider className="jan-workspace relative">
        {services ? (
          <>
            <ConfiguredTheme
              transport={services.transport}
              initialTheme={initialTheme}
            />
            <AppLayoutContent
              key={attempt}
              transport={services.transport}
              connectionError={connectionError}
              reconnect={reconnect}
            />
          </>
        ) : (
          <p className="m-auto text-sm text-muted-foreground" role="status">
            Opening workspace…
          </p>
        )}
      </SidebarProvider>
    </AuiProvider>
  );
}
