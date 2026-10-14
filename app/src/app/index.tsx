// Purpose: Compose shared providers and the prototype application routes.
import type { Theme } from "@openchart/app/lib/theme/theme";
import type { BackendConnection } from "@openchart/app/lib/transport/transport";
import { AppHostProvider, type AppHost } from "@openchart/app/lib/host/host";

import { AppProvider } from "./provider";
import { AppRouter } from "./router";

export const App = ({
  connection,
  initialTheme = "system",
  host,
}: {
  connection: BackendConnection;
  initialTheme?: Theme;
  host: AppHost;
}) => {
  return (
    <AppHostProvider value={host}>
      <AppProvider key={`${connection.profileID ?? ""}:${connection.origin}`}>
        <AppRouter connection={connection} initialTheme={initialTheme} />
      </AppProvider>
    </AppHostProvider>
  );
};
