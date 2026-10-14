// Purpose: Collects native provider answers using the shared Questionnaire.
import { useRef, useState } from "react";
import { Button } from "@openchart/app/components/ui/button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@openchart/app/components/ui/questionnaire";
import type {
  QuestionReply,
  QuestionRequest,
} from "@openchart/app/lib/agent/client";

/** Keeps unsent answers local; a failed submission leaves the questionnaire editable. */
export function QuestionCard({
  request,
  disabled,
  onReply,
}: {
  request: QuestionRequest;
  disabled: boolean;
  onReply: (requestID: string, reply: QuestionReply) => Promise<void>;
}) {
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function reply(answer: QuestionReply) {
    if (sending.current || disabled) return;
    sending.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onReply(request.id, answer);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn’t submit answers. Please try again.",
      );
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return (
    <div className="mb-3 w-full max-w-sm rounded-2xl border border-border/60 bg-background p-3.5 dark:bg-popover">
      <Questionnaire
        aria-label="Agent questions"
        aria-busy={pending}
        items={request.questions.map((question) => ({
          name: question.id,
          required: true,
          choices: question.options.map((option) => ({ value: option.label })),
        }))}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void reply({
            type: "answered",
            answers: Object.fromEntries(
              request.questions.map((question) => [
                question.id,
                data
                  .getAll(question.id)
                  .map(String)
                  .filter((value) => value.trim()),
              ]),
            ),
          });
        }}
      >
        <fieldset
          disabled={disabled || pending}
          className="flex min-w-0 flex-col gap-3"
        >
          <QuestionnaireProgress className="min-w-0 text-[11px] font-normal text-foreground/45" />
          {request.questions.map((question) => (
            <QuestionnaireItem
              key={question.id}
              name={question.id}
              required
              multiple={question.multiple}
              className="gap-2.5"
            >
              <QuestionnaireTitle className="text-[13.5px] text-foreground/90">
                {question.question}
              </QuestionnaireTitle>
              <QuestionnaireDescription
                className={
                  question.multiple ? "text-xs text-foreground/50" : "sr-only"
                }
              >
                {question.header}
                {question.multiple ? " · Select all that apply" : ""}
              </QuestionnaireDescription>
              <QuestionnaireChoices className="gap-1.5">
                {question.options.map((option) => (
                  <QuestionnaireChoice
                    key={option.label}
                    value={option.label}
                    className="min-h-0 gap-2 border-border/60 px-2.5 py-2 text-[13px] hover:bg-foreground/[0.04] data-[checked]:border-foreground/25 data-[checked]:bg-foreground/[0.04] dark:bg-transparent dark:data-[checked]:bg-foreground/[0.06]"
                  >
                    <span className="font-medium">{option.label}</span>
                    {option.description && (
                      <QuestionnaireChoiceDescription className="text-xs text-foreground/45">
                        {option.description}
                      </QuestionnaireChoiceDescription>
                    )}
                  </QuestionnaireChoice>
                ))}
                {question.allowFreeform && (
                  <QuestionnaireInput
                    aria-label={`Your answer: ${question.header}`}
                    placeholder={
                      question.options.length
                        ? "Or type your own answer…"
                        : "Type your answer…"
                    }
                    type={question.secret ? "password" : "text"}
                    autoComplete="off"
                    className="min-h-0 border-border/60 text-xs placeholder:text-foreground/35 dark:bg-transparent md:text-xs"
                  />
                )}
              </QuestionnaireChoices>
              <QuestionnaireError className="mt-0 text-xs">
                Please answer this question to continue.
              </QuestionnaireError>
            </QuestionnaireItem>
          ))}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <QuestionnaireActions className="min-h-0 gap-1.5 border-t border-border/60 pt-2.5 sm:min-h-0">
            <QuestionnairePrevious
              size="xs"
              variant="ghost"
              className="h-7 min-h-0 text-foreground/55"
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="col-start-2 row-start-1 h-7 justify-self-end text-foreground/55"
              onClick={() => void reply({ type: "skipped" })}
            >
              Skip questions
            </Button>
            <QuestionnaireNext size="xs" className="h-7 min-h-0 px-2.5" />
            <QuestionnaireSubmit size="xs" className="h-7 min-h-0 px-2.5">
              {pending ? "Sending…" : "Submit answers"}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </fieldset>
      </Questionnaire>
    </div>
  );
}
