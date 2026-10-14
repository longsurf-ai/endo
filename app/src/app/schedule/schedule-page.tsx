// Purpose: Place Schedule in the shared shell, keep the open view in the URL and open its Sessions in Copilot.
import { useAssistantContext } from "@assistant-ui/react";
import {
  Navigate,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";

import { useCopilotControls } from "@openchart/app/app/agent/copilot-controls";
import { PageHeader } from "@openchart/app/app/page-header";
import type { AppRouteContext } from "@openchart/app/app/route-context";
import { Tabs, TabsList, TabsTrigger } from "@openchart/app/components/ui/tabs";
import { ScheduleView } from "@openchart/app/features/schedule/components/schedule-view";
import { SchedulePromptEditor } from "./schedule-prompt-editor";
import { NewScheduleMenu } from "./new-schedule-menu";

const calendarPath = "/app/schedule/calendar";
const listPath = "/app/schedule";

/** Mount Schedule at `/app/schedule` (list) or `/app/schedule/calendar`; an unknown view redirects to the list. @example <SchedulePage /> */
export function SchedulePage() {
  const { transport } = useOutletContext<AppRouteContext>();
  const { view } = useParams();
  const navigate = useNavigate();
  const copilot = useCopilotControls();
  useAssistantContext({ getContext: () => "user is in schedule page" });
  const current = view === "calendar" ? "calendar" : "list";
  if (view !== undefined && view !== "calendar")
    return <Navigate to={listPath} replace />;
  return (
    <ScheduleView
      transport={transport}
      view={current}
      renderCreateAction={(open) => (
        <NewScheduleMenu transport={transport} onManual={open} />
      )}
      renderPromptEditor={(props) => (
        <SchedulePromptEditor transport={transport} {...props} />
      )}
      onOpenSession={(sessionID) => copilot?.selectSession(sessionID)}
      renderHeader={(createAction) => (
        <PageHeader
          actions={createAction}
          center={
            <Tabs
              value={current}
              onValueChange={(next) => {
                void navigate(next === "calendar" ? calendarPath : listPath);
              }}
            >
              <TabsList aria-label="View" className="grid grid-cols-2">
                <TabsTrigger value="list">List</TabsTrigger>
                <TabsTrigger value="calendar">Calendar</TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          <h1 className="truncate font-studio text-base font-medium">
            Schedule
          </h1>
        </PageHeader>
      )}
    />
  );
}
