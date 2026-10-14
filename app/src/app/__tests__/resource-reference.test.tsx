import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, useParams } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownText } from "@openchart/app/features/agent/components/thread/transcript/markdown/markdown-text";
import { ResourceNavigationProvider } from "@openchart/app/app/resource-navigation";

const convertMessage = (message: ThreadMessageLike) => message;
function Message() {
  return <MessagePrimitive.Parts components={{ Text: MarkdownText }} />;
}
function Markdown({ text }: { text: string }) {
  const runtime = useExternalStoreRuntime({
    messages: [{ id: "reply", role: "assistant", content: text }],
    convertMessage,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root aria-label="Response">
        <ThreadPrimitive.Messages components={{ Message }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

const routers: ReturnType<typeof createMemoryRouter>[] = [];
afterEach(() => {
  for (const router of routers.splice(0)) router.dispose();
});

function Rule() {
  return <h1>Rule {useParams().ruleId}</h1>;
}

it("renders Assistant references as chips and follows an unvisited route using keyboard navigation", async () => {
  const user = userEvent.setup();
  const lazy = vi.fn(async () => ({ Component: Rule }));
  const router = createMemoryRouter(
    [
      {
        path: "/app",
        children: [
          {
            path: "chat",
            element: (
              <Markdown
                text={
                  "Rule: :resource[Price alert]{name=alert_rule/alr_one}\n\nNotification: :resource[Notify]{name=trigger/trg_one}"
                }
              />
            ),
          },
          {
            path: "alerts/:ruleId",
            handle: { resource: { name: "alert_rule", idParam: "ruleId" } },
            lazy,
          },
        ],
      },
    ],
    { initialEntries: ["/app/chat"] },
  );
  routers.push(router);
  render(
    <ResourceNavigationProvider routes={router.routes}>
      <RouterProvider router={router} />
    </ResourceNavigationProvider>,
  );
  const link = await screen.findByRole("link", {
    name: "alert_rule: Price alert",
  });
  expect(link).toHaveAttribute("href", "/app/alerts/alr_one");
  expect(link).toHaveAttribute("title", "alr_one");
  expect(link).toHaveAttribute("data-slot", "directive-text-chip");
  expect(screen.getByLabelText("trigger: Notify")).toHaveAttribute(
    "title",
    "trg_one",
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(lazy).not.toHaveBeenCalled();
  await user.tab();
  expect(link).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("heading", { name: "Rule alr_one" }),
  ).toBeVisible();
});

it("supports all Resource types without navigation or a mounted application host", async () => {
  render(
    <Markdown
      text={
        "**Saved** :resource[Chart]{name=chart/cht_one}\n\n- :resource[Drawing]{name=drawing/drw_one}\n\n| Resource |\n| --- |\n| :resource[Future]{name=future_resource/future_one} |"
      }
    />,
  );
  expect(await screen.findByLabelText("chart: Chart")).toHaveTextContent(
    "Chart",
  );
  expect(screen.getByLabelText("drawing: Drawing")).toBeVisible();
  expect(screen.getByRole("cell")).toHaveTextContent("Future");
  expect(screen.getByLabelText("future_resource: Future")).toHaveAttribute(
    "title",
    "future_one",
  );
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("preserves unknown, incomplete and invalid syntax while streaming", async () => {
  const partial = ":resource[Rule]{name=alert_rule/";
  const { rerender } = render(<Markdown text={partial} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Response")).toHaveTextContent(partial),
  );
  expect(screen.queryByLabelText("alert_rule: Rule")).not.toBeInTheDocument();
  rerender(<Markdown text={partial + "alr_one}"} />);
  expect(await screen.findByLabelText("alert_rule: Rule")).toHaveAttribute(
    "title",
    "alr_one",
  );
  rerender(
    <Markdown
      text={
        ':unknown[Keep]{id=x}\n\n:resource[Bad]{name=alert_rule/alr_one href="https://example.com"}\n\n:resource[Missing]{name=alert_rule}'
      }
    />,
  );
  expect(await screen.findByText(":unknown[Keep]{id=x}")).toBeVisible();
  expect(
    screen.getByText(
      ':resource[Bad]{name=alert_rule/alr_one href="https://example.com"}',
    ),
  ).toBeVisible();
  expect(screen.getByText(":resource[Missing]{name=alert_rule}")).toBeVisible();
  expect(screen.queryByLabelText("alert_rule: Bad")).not.toBeInTheDocument();
});

it("keeps code, escaped directives and references inside links literal", async () => {
  const source = ":resource[Literal]{name=alert_rule/alr_one}";
  render(
    <Markdown
      text={[
        `\`${source}\``,
        `\`\`\`text\n${source}\n\`\`\``,
        `\\${source}`,
        `[${source}](#example)`,
      ].join("\n\n")}
    />,
  );
  const link = await screen.findByRole("link", { name: source });
  expect(link).toHaveAttribute("href", "#example");
  expect(
    screen.queryByLabelText("alert_rule: Literal"),
  ).not.toBeInTheDocument();
});

it("decodes Assistant label escapes without stripping literal markup twice", async () => {
  render(
    <Markdown
      text={String.raw`:resource[Price &#91;USD&#93; **alert** \*literal\*]{name=alert_rule/alr_one}`}
    />,
  );
  expect(
    await screen.findByLabelText("alert_rule: Price [USD] alert *literal*"),
  ).toHaveTextContent("Price [USD] alert *literal*");
});
