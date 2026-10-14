import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
import { findErrorToast } from "@openchart/app/testing/test-utils";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
// Purpose: Exercises native provider setup states and explicit Settings actions.
import { CLAUDE_CODE, CODEX } from "@openchart/models/model-tiers";
import type { ProviderDiscoveryResult } from "@openchart/models/model-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  NativeProvider,
  RefreshProviders,
} from "@openchart/app/app/routes/settings/native-provider";
import { useConfig } from "@openchart/app/hooks/use-config";
import { createTransport } from "@openchart/app/lib/transport/transport";

const rpc = vi.hoisted(() => ({
  events: { subscribe: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) } },
  config: { get: { query: vi.fn() }, update: { mutate: vi.fn() } },
  models: {
    discover: { query: vi.fn() },
    quota: { query: vi.fn() },
    refresh: { mutate: vi.fn() },
    setupState: { query: vi.fn() },
    startSetup: { mutate: vi.fn() },
    writeSetup: { mutate: vi.fn() },
    cancelSetup: { mutate: vi.fn() },
  },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  rpc.events.subscribe.subscribe.mockReturnValue({ unsubscribe: vi.fn() });
  rpc.models.setupState.query.mockResolvedValue({ status: "idle" });
  rpc.models.quota.query.mockResolvedValue({ status: "not_applicable" });
  client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());
function mount(
  result: ProviderDiscoveryResult,
  includeClaude = false,
  enabled = true,
) {
  rpc.config.get.query.mockResolvedValue({
    appearance: { theme: "system" },
    providers: { binance: { enabled: false }, yfinance: { enabled: false } },
    models: {
      providers: {
        codex: { enabled },
        "claude-code": { enabled },
      },
    },
  });
  rpc.models.discover.query.mockResolvedValue(result);
  const transport = createTransport({ origin: "http://127.0.0.1:41000" });
  function Settings() {
    const settings = useConfig(transport);
    return settings.config ? (
      <>
        <NativeProvider
          providerID={CODEX}
          transport={transport}
          settings={settings}
          enabled={settings.config.models.providers.codex.enabled}
        />
        {includeClaude ? (
          <NativeProvider
            providerID={CLAUDE_CODE}
            transport={transport}
            settings={settings}
            enabled={settings.config.models.providers[CLAUDE_CODE].enabled}
          />
        ) : null}
        <RefreshProviders transport={transport} />
      </>
    ) : null;
  }
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
}
const login: ProviderDiscoveryResult = {
  status: "authentication_required",
  login: { executable: "/native/codex", args: ["login"] },
};

test("draws one labelled ring per plan meter for a ready provider and none otherwise", async () => {
  rpc.models.quota.query.mockResolvedValue({
    status: "ready",
    plan: "max",
    blocked: true,
    meters: [
      {
        scope: { kind: "account" },
        window: { kind: "duration", minutes: 300 },
        usage: { kind: "percent", usedPercent: 12 },
        resetsAt: "2026-09-24T23:40:00.000Z",
      },
      {
        scope: { kind: "model", name: "Fable" },
        window: { kind: "duration", minutes: 10080 },
        usage: { kind: "percent", usedPercent: 38 },
      },
      {
        scope: { kind: "account" },
        window: { kind: "month" },
        usage: { kind: "spend", used: 50, limit: 200, currency: "USD" },
      },
      { scope: { kind: "account" } },
    ],
  });
  mount({
    status: "ready",
    provider: { id: CODEX, name: "Codex", models: [] },
  });
  const group = await screen.findByRole("group", { name: "Plan usage" });
  expect(
    screen.getByRole("button", { name: "5-hour: 12% used" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Weekly · Fable: 38% used" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Monthly: 25% used" }),
  ).toBeVisible();
  expect(within(group).getAllByRole("button")).toHaveLength(3);
  expect(group).toHaveTextContent("Limit reached");
  expect(rpc.models.quota.query).toHaveBeenCalledWith(
    { providerID: CODEX },
    expect.anything(),
  );
  rpc.models.quota.query.mockRejectedValue(new Error("offline"));
  await act(() => client.invalidateQueries({ queryKey: ["native-provider"] }));
  expect(await screen.findByText("Usage unavailable")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Codex" })).toBeVisible();
});

test("does not read plan usage for providers that are not ready", async () => {
  mount(login);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
  expect(rpc.models.quota.query).not.toHaveBeenCalled();
});

test("one recheck refreshes both providers, including disabled ones", async () => {
  mount(login, true, false);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(2),
  );
  expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(
    1,
  );
  rpc.models.discover.query.mockClear().mockImplementation(({ providerID }) =>
    Promise.resolve({
      status: "ready",
      provider: { id: providerID, name: providerID, models: [] },
    }),
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check again" }));
  expect(rpc.models.refresh.mutate).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.getAllByText("Enable to use this provider.")).toHaveLength(2),
  );
  for (const providerID of [CODEX, CLAUDE_CODE]) {
    expect(rpc.models.discover.query).toHaveBeenCalledWith(
      { providerID },
      expect.anything(),
    );
  }
});

test("a shared refresh failure stays visible and can be retried", async () => {
  mount(login);
  const user = userEvent.setup();
  rpc.models.refresh.mutate.mockRejectedValueOnce(new Error("Refresh failed"));
  await user.click(await screen.findByRole("button", { name: "Check again" }));
  expect(await findErrorToast("Refresh failed")).toHaveTextContent(
    "Refresh failed",
  );
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(rpc.models.refresh.mutate).toHaveBeenCalledTimes(2);
});

test("inspects disabled providers and offers installation without starting setup", async () => {
  mount({ status: "not_installed" }, false, false);
  expect(await screen.findByRole("button", { name: "Install" })).toBeVisible();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(rpc.models.discover.query).toHaveBeenCalledWith(
    { providerID: CODEX },
    expect.anything(),
  );
  expect(rpc.models.startSetup.mutate).not.toHaveBeenCalled();
  expect(rpc.config.update.mutate).not.toHaveBeenCalled();
});

test("replaces install with login and only shows the default-enabled switch when ready", async () => {
  mount({ status: "not_installed" });
  expect(await screen.findByRole("button", { name: "Install" })).toBeVisible();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  rpc.models.discover.query.mockResolvedValue(login);
  await act(() => client.invalidateQueries({ queryKey: ["native-provider"] }));
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Install" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  rpc.models.discover.query.mockResolvedValue({
    status: "ready",
    provider: { id: CODEX, name: "Codex", models: [] },
  });
  await act(() => client.invalidateQueries({ queryKey: ["native-provider"] }));
  expect(await screen.findByRole("switch", { name: "Codex" })).toBeChecked();
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(rpc.config.update.mutate).not.toHaveBeenCalled();
});

test("preserves an explicitly disabled ready provider and allows enabling it", async () => {
  mount(
    {
      status: "ready",
      provider: { id: CODEX, name: "Codex", models: [] },
    },
    false,
    false,
  );
  expect(
    await screen.findByRole("switch", { name: "Codex" }),
  ).not.toBeChecked();
  expect(rpc.config.update.mutate).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("switch", { name: "Codex" }));
  await waitFor(() =>
    expect(rpc.config.update.mutate).toHaveBeenCalledWith({
      models: { providers: { codex: { enabled: true } } },
    }),
  );
});

test("one install click sends only the provider and action and shows download progress", async () => {
  mount({ status: "not_installed" });
  const operation = {
    status: "running",
    id: "install",
    action: "install",
    output: "Downloading version 0.156.0… 12 MB",
  };
  const install = await screen.findByRole("button", { name: "Install" });
  rpc.models.startSetup.mutate.mockResolvedValue(operation);
  rpc.models.setupState.query.mockResolvedValue(operation);
  await userEvent.setup().click(install);
  expect(rpc.models.startSetup.mutate).toHaveBeenCalledExactlyOnceWith({
    providerID: CODEX,
    action: "install",
  });
  expect(await screen.findByRole("status")).toHaveTextContent("12 MB");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Install" }),
  ).not.toBeInTheDocument();
});

test("automatic update progress appears without a click, and failed installation can be retried", async () => {
  const operation = {
    status: "running",
    id: "automatic",
    action: "install",
    output: "Installing provider…",
  };
  rpc.models.setupState.query.mockResolvedValue(operation);
  mount({ status: "not_installed" });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Installing provider…",
  );
  expect(rpc.models.startSetup.mutate).not.toHaveBeenCalled();
  rpc.models.setupState.query.mockResolvedValue({
    ...operation,
    status: "failed",
    output: "Download failed",
  });
  await act(() =>
    client.invalidateQueries({ queryKey: ["agent", "provider-setup"] }),
  );
  expect(await screen.findByText("Download failed")).toBeVisible();
  expect(await screen.findByRole("button", { name: "Install" })).toBeEnabled();
});

test("login supports output, manual code input, cancellation, and fresh status", async () => {
  mount(login);
  const user = userEvent.setup();
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  const operation = {
    status: "running",
    id: "login-1",
    action: "login",
    output:
      "Open the provider browser to sign in.\nhttps://accounts.example/auth?x=1\n",
  };
  rpc.models.startSetup.mutate.mockResolvedValue(operation);
  rpc.models.setupState.query.mockResolvedValue(operation);
  await user.click(signIn);
  expect(rpc.models.startSetup.mutate).toHaveBeenCalledExactlyOnceWith({
    providerID: CODEX,
    action: "login",
  });
  const code = await screen.findByRole("textbox", {
    name: "Authorization code for Codex",
  });
  // Login output may carry the sign-in URL or code, so it stays reachable.
  expect(
    screen.getByText(/Open the provider browser to sign in\./),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "https://accounts.example/auth?x=1" }),
  ).toHaveAttribute("target", "_blank");
  await user.type(code, "manual-code");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(rpc.models.writeSetup.mutate).toHaveBeenCalledWith({
    providerID: CODEX,
    id: "login-1",
    text: "manual-code",
  });
  await waitFor(() => expect(code).toHaveValue(""));
  rpc.models.setupState.query.mockResolvedValue({
    ...operation,
    status: "cancelled",
  });
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(rpc.models.cancelSetup.mutate).toHaveBeenCalledWith({
    providerID: CODEX,
    id: "login-1",
  });
  // Cancellation speaks through the card: login is offered again, setup UI is gone.
  await screen.findByRole("button", { name: "Sign in" });
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Open the provider browser to sign in\./),
  ).not.toBeInTheDocument();
  rpc.models.discover.query.mockResolvedValue({
    status: "ready",
    provider: { id: CODEX, name: "Codex", models: [] },
  });
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(rpc.models.refresh.mutate).toHaveBeenCalledOnce();
  expect(await screen.findByRole("switch", { name: "Codex" })).toBeChecked();
  expect(rpc.config.update.mutate).not.toHaveBeenCalled();
});

test("failed sign-in keeps old instructions in details and retries with a fresh input and operation", async () => {
  const operation = {
    status: "running",
    id: "login-old",
    action: "login",
    output: "https://accounts.example/old\nPaste the authorization code here.",
  };
  rpc.models.setupState.query.mockResolvedValue(operation);
  mount(login);
  const user = userEvent.setup();
  await user.type(await screen.findByRole("textbox"), "expired-code");
  rpc.models.setupState.query.mockResolvedValue({
    ...operation,
    status: "failed",
    output: operation.output + "\nTLS handshake timeout",
  });
  await act(() =>
    client.invalidateQueries({ queryKey: ["agent", "provider-setup"] }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Sign-in failed. Please try again.",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  const details = screen.getByRole("button", { name: "Error details" });
  expect(details).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/TLS handshake timeout/)).not.toBeInTheDocument();
  await user.click(details);
  expect(await screen.findByText(/TLS handshake timeout/)).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();

  const retry = {
    ...operation,
    id: "login-new",
    output: "https://accounts.example/new",
  };
  rpc.models.startSetup.mutate.mockResolvedValue(retry);
  rpc.models.setupState.query.mockResolvedValue(retry);
  await user.click(screen.getByRole("button", { name: "Retry sign-in" }));
  expect(rpc.models.startSetup.mutate).toHaveBeenCalledExactlyOnceWith({
    providerID: CODEX,
    action: "login",
  });
  const code = await screen.findByRole("textbox");
  expect(code).toHaveValue("");
  expect(screen.getByRole("link")).toHaveAttribute(
    "href",
    "https://accounts.example/new",
  );
  expect(screen.queryByText(/TLS handshake timeout/)).not.toBeInTheDocument();
  expect(screen.queryByText("Error details")).not.toBeInTheDocument();
  await user.type(code, "fresh-code");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(rpc.models.writeSetup.mutate).toHaveBeenCalledExactlyOnceWith({
    providerID: CODEX,
    id: "login-new",
    text: "fresh-code",
  });
});

test("completed installation does not claim successful discovery; recheck can recover", async () => {
  rpc.models.setupState.query.mockResolvedValue({
    status: "succeeded",
    id: "installed",
    action: "install",
    output: "Installed. Checking sign-in status…",
  });
  mount(login);
  await screen.findByRole("button", { name: "Sign in" });
  rpc.models.discover.query.mockRejectedValue(
    new Error("Could not read sign-in status"),
  );
  await act(() => client.invalidateQueries({ queryKey: ["native-provider"] }));
  expect(
    await findErrorToast("Could not read sign-in status"),
  ).toHaveTextContent("Could not read sign-in status");
  expect(screen.getByText("Couldn’t check this provider.")).toBeInTheDocument();
  expect(screen.queryByText("Provider installed.")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Installed. Checking sign-in status…"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Provider status has been refreshed/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  rpc.models.discover.query.mockResolvedValue(login);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByRole("button", { name: "Sign in" });
});
