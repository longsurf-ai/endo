// Purpose: Apply the native browser theme from confirmed Config reads, with a startup-only hint.

import { useQuery } from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";

import {
  configQueryOptions,
  type AppConfig,
} from "@openchart/app/lib/config/config";
import type {
  AppTransport,
  BackendConnection,
} from "@openchart/app/lib/transport/transport";

/** Theme preference is owned by settings.json; OS appearance is derived. */
export type Theme = AppConfig["appearance"]["theme"];

const isDarkTheme = () => document.documentElement.classList.contains("dark");
function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

/** Follow the applied app theme, including changes between render and subscription.
 * @example const dark = useDarkTheme();
 */
export function useDarkTheme() {
  return useSyncExternalStore(subscribeTheme, isDarkTheme);
}

/** Cache identity survives desktop port changes and never contains its access token. @example themeStorageKey({ origin: location.origin }); */
export function themeStorageKey(connection: BackendConnection) {
  return `openchart-v2-theme:${connection.profileID ?? connection.origin}`;
}

function applyTheme(theme: Theme, systemDark: boolean) {
  const dark = theme === "dark" || (theme === "system" && systemDark);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

/** Reads the profile's hint once before mounting React. Unavailable/invalid storage falls back to system; this never writes storage. @example const initialTheme = bootstrapTheme(connection); */
export function bootstrapTheme(connection: BackendConnection): Theme {
  let theme: Theme = "system";
  try {
    const cached = localStorage.getItem(themeStorageKey(connection));
    if (cached === "dark" || cached === "light" || cached === "system")
      theme = cached;
  } catch {
    /* An optional startup hint must not prevent opening the app. */
  }
  applyTheme(theme, matchMedia("(prefers-color-scheme: dark)").matches);
  return theme;
}

/** Applies one controlled preference and releases its OS listener on unmount. It has no store or persistence. @example <ThemeProvider theme="system"><App /></ThemeProvider> */
export function ThemeProvider({
  theme = "system",
  children,
}: {
  theme?: Theme;
  children?: ReactNode;
}) {
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyTheme(theme, media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return children;
}

/** Query owns the preference after loading. Only confirmed reads refresh the startup hint; failed reads preserve the last theme. @example <ConfiguredTheme transport={transport} initialTheme="system" /> */
export function ConfiguredTheme({
  transport,
  initialTheme,
}: {
  transport: AppTransport;
  initialTheme: Theme;
}) {
  const query = useQuery(configQueryOptions(transport));
  const theme = query.data?.appearance.theme;
  const key = themeStorageKey(transport.connection);
  useEffect(() => {
    if (!query.isSuccess || !theme) return;
    try {
      localStorage.setItem(key, theme);
    } catch {
      /* Config remains saved if the optional cache is unavailable. */
    }
  }, [key, query.isSuccess, query.dataUpdatedAt, theme]);
  return <ThemeProvider theme={theme ?? initialTheme} />;
}
