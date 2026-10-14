// Purpose: Carries native clarification requests to the host without application dependencies.

/** Shape-only question view; adapters parse native input before calling the host. */
export interface ProviderQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
  }[];
  readonly multiple: boolean;
  readonly allowFreeform: boolean;
  readonly secret: boolean;
}

/** One native invocation; question IDs are scoped to this request. */
export interface ProviderQuestionRequest {
  readonly questions: readonly ProviderQuestion[];
}

/** A deliberate skip is distinct from a submitted answer or request cancellation. */
export type ProviderQuestionReply =
  | {
      readonly type: "answered";
      readonly answers: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly type: "skipped" };

/** The host owns waiting and cleanup; native resolution aborts the supplied signal. */
export type ProviderQuestionAsk = (
  request: ProviderQuestionRequest,
  options: { readonly signal: AbortSignal },
) => Promise<ProviderQuestionReply>;
