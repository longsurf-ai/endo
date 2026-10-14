// Purpose: Place each Settings section in the shared section frame with Config status.
// The frame and rail live in app/section-page.
import { Palette, ScrollText, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { SectionPage } from "@openchart/app/app/section-page";
import { Button } from "@openchart/app/components/ui/button";
import { Card, CardItem } from "@openchart/app/components/ui/settings/card";
import type { useConfig } from "@openchart/app/hooks/use-config";

/** UI navigation metadata; section names and ordering are not user configuration. */
export const settingsSections = [
  { path: "/app/settings/interface", title: "Appearance", icon: Palette },
  { path: "/app/settings/models", title: "Models", icon: SlidersHorizontal },
  { path: "/app/settings/changelog", title: "Changelog", icon: ScrollText },
] as const;

/** The two Settings panes follow the persistent application sidebar. @example <SettingsPage title="Appearance" settings={settings}>{content}</SettingsPage> */
export function SettingsPage({
  title,
  settings,
  children,
}: {
  title: string;
  settings?: ReturnType<typeof useConfig>;
  children: ReactNode;
}) {
  return (
    <SectionPage
      heading="Settings"
      label={`${title} settings`}
      sections={settingsSections}
      status={
        settings?.isSaving || settings?.isSaved ? (
          <span role="status" className="text-xs text-muted-foreground">
            {settings.isSaving ? "Saving…" : "Saved."}
          </span>
        ) : null
      }
    >
      {settings?.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading settings…
        </p>
      ) : null}
      {settings?.readError ? (
        <Card>
          <div role="alert">
            <CardItem
              title="Couldn’t refresh settings."
              description={
                settings.config
                  ? "The values shown may be out of date."
                  : "Try reading the settings again."
              }
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void settings.refresh();
                  }}
                >
                  Retry
                </Button>
              }
            />
          </div>
        </Card>
      ) : null}

      {children}
    </SectionPage>
  );
}
