# Agent presentation

- Reuse assistant-ui ChatGPT views. One Thinking Indicator; ToolCall and
  Working/Worked share Collapsible motion. Timing uses message timestamps:
  now minus creation while running, completion minus creation when stopped.
  Keep final answers outside, failed/unfinished work expanded, and everything
  left-aligned.
- TaskCard uses title/native lifecycle and `my-1`; clicks open childSessionId
  in AgentPanel. No inline transcripts; hide composer/Quote, retain Dig In.
- App owns navigation/placement; AgentProvider only shares Agent. AgentView shows
  one Session. AgentPanel owns nesting/Back, retains covered composers, and resets
  nesting on root Session changes. Revealing the root keeps nested views mounted
  and hidden so their drafts survive. Dig In stays local until Send, creates once,
  and reuses its child for retries. Hosts supply SessionPicker selection/disabled
  state; Query owns metadata.
- Composer/Transcript share one runtime. AgentLayout owns viewport/footer/empty
  state; permissions/errors stay visible. Hosts submit; restore failed drafts
  into that Session's empty composer. Conversion/commands stay outside presentation.
- Quote reuses upstream primitives/QuoteBlock and persisted ContextPart metadata.
  Parent anchors own Markdown ranges; child Run drives ShimmerLabel. Backend hides
  copied history. Native attribution drives cards; final parent replies get
  actions. Branches use canonical Message IDs and host navigation.
- Workflow Activity carries OTLP: group spans by phase then Session in TraceWaterfall.
  Reuse Collapsible, the common time axis and host navigation; add no trace store.
- Preserve Markdown/math/streaming code. Lazy Mermaid uses upstream zoom; DOMPurify
  sanitizes SVG.
