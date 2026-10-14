// Purpose: List the release notes bundled with this build in the shared Settings layout.
// A version/date rail beside bullet items in one settings card, without titles, images or links.
import { Badge } from "@openchart/app/components/ui/badge";
import { Card } from "@openchart/app/components/ui/settings/card";
import { useAppHost } from "@openchart/app/lib/host/host";

import { SettingsPage } from "./settings-page";

// Dates name a calendar day; UTC keeps them from shifting a day in western time zones.
const day = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/** Newest release first, as Desktop bundled it. @example <ChangelogSettings /> */
export default function ChangelogSettings() {
  const { changelog } = useAppHost();
  return (
    <SettingsPage title="Changelog">
      <Card title="Changelog">
        <ol>
          {changelog.map((entry) => (
            <li
              key={entry.version}
              className="flex flex-col gap-3 border-b border-border/40 py-4 first:pt-0 last:border-none last:pb-0 md:flex-row md:gap-8"
            >
              <div className="flex h-min w-36 shrink-0 items-center gap-3 md:sticky md:top-0">
                <Badge variant="secondary">{entry.version}</Badge>
                <time
                  dateTime={entry.date}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {day.format(new Date(entry.date))}
                </time>
              </div>
              <ul className="ml-4 list-disc space-y-1.5">
                {entry.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Card>
    </SettingsPage>
  );
}
