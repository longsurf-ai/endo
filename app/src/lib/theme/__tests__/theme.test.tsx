// Purpose: Verify native OS theming and that only successful Config reads update the startup hint.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { refreshConfig } from "@openchart/app/lib/config/config";
import {
  bootstrapTheme,
  ConfiguredTheme,
  ThemeProvider,
  themeStorageKey,
} from "@openchart/app/lib/theme/theme";
import { createTransport } from "@openchart/app/lib/transport/transport";

const rpc = vi.hoisted(() => ({ config: { get: { query: vi.fn() } } }));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));
const connection = {
  origin: "http://127.0.0.1:41000",
  profileID: "theme-test",
};
const cacheKey = themeStorageKey(connection);
let media: EventTarget & { matches: boolean };

beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  localStorage.removeItem(cacheKey);
  document.documentElement.className = "";
});
afterEach(() => {
  localStorage.removeItem(cacheKey);
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  vi.clearAllMocks();
});

function systemDark(dark: boolean) {
  act(() => {
    media.matches = dark;
    media.dispatchEvent(new Event("change"));
  });
}

test("controlled system mode follows OS without saving; explicit themes ignore OS changes", () => {
  const view = render(<ThemeProvider theme="system" />);
  expect(document.documentElement).toHaveClass("light");
  systemDark(true);
  expect(document.documentElement).toHaveClass("dark");
  expect(document.documentElement).toHaveStyle({ colorScheme: "dark" });
  view.rerender(<ThemeProvider theme="light" />);
  systemDark(false);
  systemDark(true);
  expect(document.documentElement).toHaveClass("light");
  expect(localStorage.getItem(cacheKey)).toBeNull();
  view.unmount();
  systemDark(false);
  expect(document.documentElement).toHaveClass("light");
});

test("bootstrap restores a stable profile hint; storage events cannot override Config and failed reads cannot write cache", async () => {
  localStorage.setItem(cacheKey, "dark");
  const initialTheme = bootstrapTheme({
    ...connection,
    origin: "http://127.0.0.1:42000",
  });
  expect(initialTheme).toBe("dark");
  expect(document.documentElement).toHaveClass("dark");
  rpc.config.get.query.mockRejectedValue(new Error("offline"));
  const transport = createTransport(connection);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ConfiguredTheme transport={transport} initialTheme={initialTheme} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(client.getQueryState([["config"]])?.status).toBe("error"),
  );
  expect(localStorage.getItem(cacheKey)).toBe("dark");
  await act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: cacheKey, newValue: "light" }),
    ),
  );
  expect(document.documentElement).toHaveClass("dark");

  rpc.config.get.query.mockResolvedValue({ appearance: { theme: "light" } });
  await act(() => refreshConfig(client));
  await waitFor(() => expect(localStorage.getItem(cacheKey)).toBe("light"));
  expect(document.documentElement).toHaveClass("light");
  rpc.config.get.query.mockRejectedValue(new Error("invalid settings"));
  await act(() => refreshConfig(client));
  expect(localStorage.getItem(cacheKey)).toBe("light");
  expect(document.documentElement).toHaveClass("light");
  view.unmount();
  client.clear();
});
