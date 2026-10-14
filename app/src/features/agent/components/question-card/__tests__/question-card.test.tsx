// Purpose: Exercises the actual Questionnaire on React 18 and native answer submission.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import postcss from "postcss";
import { StrictMode } from "react";
import tailwindcss from "tailwindcss";
import { expect, test, vi } from "vitest";
import { QuestionCard } from "@openchart/app/features/agent/components/question-card/question-card";
import type { QuestionRequest } from "@openchart/app/lib/agent/client";

const request: QuestionRequest = {
  id: "que_test" as QuestionRequest["id"],
  sessionID: "session",
  questions: [
    {
      id: "mode",
      header: "Mode",
      question: "Which mode?",
      options: [
        { label: "Fast", description: "Quick result" },
        { label: "Thorough", description: "More detail" },
      ],
      multiple: false,
      allowFreeform: true,
      secret: false,
    },
  ],
};

test("mounts a new question in the app's StrictMode without a ref update loop", () => {
  const onReply = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <StrictMode>
      <QuestionCard request={request} disabled={false} onReply={onReply} />
    </StrictMode>,
  );
  expect(screen.getByRole("radio", { name: /Fast/ })).toBeInTheDocument();
  view.rerender(
    <StrictMode>
      <QuestionCard request={request} disabled={true} onReply={onReply} />
    </StrictMode>,
  );
  expect(screen.getByRole("radio", { name: /Fast/ })).toBeDisabled();
});

test("submits a single choice without inventing answers", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  render(<QuestionCard request={request} disabled={false} onReply={onReply} />);
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(onReply).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: /Fast/ }));
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(onReply).toHaveBeenCalledExactlyOnceWith("que_test", {
    type: "answered",
    answers: { mode: ["Fast"] },
  });
});

test("navigates multiple questions, keeps multiple choices, and sends free text", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  const multiple = {
    ...request,
    questions: [
      { ...request.questions[0]!, multiple: true },
      {
        ...request.questions[0]!,
        id: "note",
        header: "Notes",
        question: "Any notes?",
        options: [],
      },
    ],
  };
  render(
    <QuestionCard request={multiple} disabled={false} onReply={onReply} />,
  );
  await user.click(screen.getByRole("checkbox", { name: /Fast/ }));
  await user.click(screen.getByRole("checkbox", { name: /Thorough/ }));
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(
    screen.queryByRole("checkbox", { name: /Fast/ }),
  ).not.toBeInTheDocument();
  await user.type(
    screen.getByRole("textbox", { name: "Your answer: Notes" }),
    "Keep it concise",
  );
  await user.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByRole("checkbox", { name: /Fast/ })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(onReply).toHaveBeenCalledExactlyOnceWith("que_test", {
    type: "answered",
    answers: { mode: ["Fast", "Thorough"], note: ["Keep it concise"] },
  });
});

test("Tailwind display utilities keep inactive pages and navigation visually hidden", async () => {
  const { css } = await postcss([
    tailwindcss({
      content: [
        "src/components/ui/questionnaire/questionnaire.tsx",
        "src/features/agent/components/question-card/question-card.tsx",
        "src/components/ui/button/button.tsx",
      ],
      corePlugins: ["display"],
    }),
  ]).process("@tailwind utilities;", { from: undefined });
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  try {
    const user = userEvent.setup();
    render(
      <QuestionCard
        request={{
          ...request,
          questions: [
            request.questions[0]!,
            {
              ...request.questions[0]!,
              id: "detail",
              question: "How much detail?",
            },
          ],
        }}
        disabled={false}
        onReply={vi.fn()}
      />,
    );
    // The outer fieldset groups both question fieldsets, including the hidden page.
    const [, first, second] = screen.getAllByRole("group", { hidden: true });
    const previous = screen.getByText("Previous");
    const next = screen.getByText("Next");
    const submit = screen.getByText("Submit answers");
    expect(getComputedStyle(first!).display).toBe("flex");
    expect(getComputedStyle(second!).display).toBe("none");
    expect(getComputedStyle(previous).display).toBe("none");
    expect(getComputedStyle(submit).display).toBe("none");

    await user.click(screen.getByRole("radio", { name: /Fast/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(getComputedStyle(first!).display).toBe("none");
    expect(getComputedStyle(second!).display).toBe("flex");
    expect(getComputedStyle(next).display).toBe("none");
    expect(getComputedStyle(previous).display).toBe("inline-flex");
    expect(getComputedStyle(submit).display).toBe("inline-flex");
  } finally {
    style.remove();
  }
});

test("keeps text on failure and blocks duplicate submissions while awaiting a reply", async () => {
  const user = userEvent.setup();
  let fail!: (error: Error) => void;
  const onReply = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue(undefined);
  render(<QuestionCard request={request} disabled={false} onReply={onReply} />);
  await user.type(screen.getByRole("textbox"), "Custom mode");
  await user.dblClick(screen.getByRole("button", { name: "Submit answers" }));
  expect(onReply).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Skip questions" })).toBeDisabled();
  await act(async () => fail(new Error("Connection lost")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  expect(screen.getByRole("textbox")).toHaveValue("Custom mode");
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(2));
  expect(onReply).toHaveBeenLastCalledWith("que_test", {
    type: "answered",
    answers: { mode: ["Custom mode"] },
  });
});

test("skips explicitly, and disables responses during reconnect", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <QuestionCard request={request} disabled onReply={onReply} />,
  );
  expect(screen.getByRole("button", { name: "Skip questions" })).toBeDisabled();
  view.rerender(
    <QuestionCard request={request} disabled={false} onReply={onReply} />,
  );
  await user.click(screen.getByRole("button", { name: "Skip questions" }));
  expect(onReply).toHaveBeenCalledExactlyOnceWith("que_test", {
    type: "skipped",
  });
});
