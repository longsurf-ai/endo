// Purpose: One connection shares its transport and releases each retired scope's observers.
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Observable } from "rxjs";
import { beforeEach, expect, it, vi } from "vitest";
import { useBackendConnection } from "@openchart/app/app/connection/use-backend-connection";
const factories = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("@openchart/app/lib/transport/transport", () => ({
  createTransport: factories.transport,
}));
const connection = { origin: "http://test" };
beforeEach(() => vi.resetAllMocks());
it("supplies one transport per attempt and releases the retired one's observers", async () => {
  const scopes: { active: number }[] = [];
  factories.transport.mockImplementation(() => {
    const scope = { active: 0 };
    scopes.push(scope);
    return {
      events: new Observable(() => {
        scope.active += 1;
        return () => {
          scope.active -= 1;
        };
      }),
    };
  });
  const seen: unknown[] = [];
  function Owner() {
    const { services, reconnect } = useBackendConnection(connection);
    if (services && !seen.includes(services.transport))
      seen.push(services.transport);
    return <button onClick={reconnect}>Reconnect</button>;
  }
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Owner />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(seen).toHaveLength(1));
  expect(scopes[0]!.active).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(seen).toHaveLength(2));
  expect(scopes[0]!.active).toBe(0);
  expect(scopes[1]!.active).toBeGreaterThan(0);
  view.unmount();
  expect(scopes[1]!.active).toBe(0);
  queryClient.clear();
});
