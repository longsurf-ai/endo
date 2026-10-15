// Purpose: Verify the first onboarding page shows signed-in agents as connected, offers sign-in otherwise, and always lets the user move on.
import { ANTIGRAVITY, CLAUDE_CODE, CODEX } from "@openchart/models/model-tiers";
import type { ProviderDiscoveryResult } from "@openchart/models/model-provider";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

import { ConnectAgentsPage } from "@openchart/app/app/trellis/workflows/starter/connect-agents-page";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
import { createTransport } from "@openchart/app/lib/transport/transport";

const rpc = vi.hoisted(() => ({
  events: { subscribe: { subscribe: vi.fn() } },
  models: {
    discover: { query: vi.fn() },
    quota: { query: vi.fn() },
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

beforeEach(() => {
  vi.resetAllMocks();
  rpc.events.subscribe.subscribe.mockReturnValue({ unsubscribe: vi.fn() });
  rpc.models.setupState.query.mockResolvedValue({ status: "idle" });
  rpc.models.quota.query.mockResolvedValue({ status: "not_applicable" });
});

function mount(discovery: Record<string, ProviderDiscoveryResult>) {
  rpc.models.discover.query.mockImplementation(
    async ({ providerID }: { providerID: string }) => discovery[providerID],
  );
  const onDone = vi.fn();
  const client = createQueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConnectAgentsPage
        transport={createTransport({ origin: "http://127.0.0.1:41000" })}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

const ready = (id: string): ProviderDiscoveryResult => ({
  status: "ready",
  provider: { id, name: id, models: [] },
});

test("signed-in agents connect on their own and Continue starts the tour", async () => {
  const onDone = mount({
    [CLAUDE_CODE]: ready(CLAUDE_CODE),
    [CODEX]: ready(CODEX),
    [ANTIGRAVITY]: ready(ANTIGRAVITY),
  });

  for (const name of ["Claude Code", "Codex", "Antigravity"])
    expect(
      await within(screen.getByRole("region", { name })).findByText(
        "Connected",
      ),
    ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onDone).toHaveBeenCalledOnce();
});

test("a signed-out agent asks to sign in, other agents are not yet available, and skipping moves on", async () => {
  const onDone = mount({
    [CLAUDE_CODE]: {
      status: "authentication_required",
      login: { executable: "/native/claude", args: ["login"] },
    },
    [CODEX]: { status: "not_installed" },
    [ANTIGRAVITY]: { status: "not_installed" },
  });
  const claude = screen.getByRole("region", { name: "Claude Code" });
  const signingIn = {
    status: "running",
    id: "login",
    action: "login",
    output: "",
  };
  rpc.models.startSetup.mutate.mockResolvedValue(signingIn);
  rpc.models.setupState.query.mockResolvedValue(signingIn);

  await userEvent.click(
    await within(claude).findByRole("button", { name: "Sign in" }),
  );
  expect(rpc.models.startSetup.mutate).toHaveBeenCalledExactlyOnceWith({
    providerID: CLAUDE_CODE,
    action: "login",
  });
  expect(
    await within(claude).findByText(/Complete sign-in in your browser/),
  ).toBeInTheDocument();
  for (const name of ["Codex", "Antigravity"])
    expect(
      within(screen.getByRole("region", { name })).getByRole("button", {
        name: "Install",
      }),
    ).toBeEnabled();
  expect(
    within(
      screen.getByRole("region", { name: "More agents coming soon" }),
    ).getByRole("img", { name: "Gemini" }),
  ).toBeInTheDocument();

  expect(
    screen.queryByRole("button", { name: "Continue" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(onDone).toHaveBeenCalledOnce();
});
