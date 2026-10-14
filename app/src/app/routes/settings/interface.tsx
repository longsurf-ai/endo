// Purpose: Edit file-backed appearance settings through the shared Config query.
import { useOutletContext } from "react-router";

import type { AppRouteContext } from "@openchart/app/app/route-context";
import { Card, CardItem } from "@openchart/app/components/ui/settings/card";
import { ThemeSwitcher } from "@openchart/app/components/ui/theme-switcher/theme-switcher";
import { useConfig } from "@openchart/app/hooks/use-config";

import { SettingsPage } from "./settings-page";

/** Save the backend profile's light/dark/system preference. @example <InterfaceSettings /> */
export default function InterfaceSettings() {
  const { transport } = useOutletContext<AppRouteContext>();
  const settings = useConfig(transport);
  return (
    <SettingsPage title="Appearance" settings={settings}>
      {settings.config ? (
        <Card title="Appearance">
          <CardItem
            title="Theme"
            description="Use light, dark, or your system appearance."
            actions={
              <ThemeSwitcher
                theme={settings.config.appearance.theme}
                disabled={settings.isSaving || !!settings.readError}
                onChange={(theme) => settings.update({ appearance: { theme } })}
              />
            }
          />
        </Card>
      ) : null}
    </SettingsPage>
  );
}
