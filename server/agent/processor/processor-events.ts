// Purpose: Defines processor event names and documents their lifecycle without dependencies.

/**
 * Normal model-stream lifecycle (* = zero or more; [] = optional):
 *
 * ```
 * start
 *   |
 *   v
 * start-step <------------------------------------+
 *   |                                             |
 *   |  text, reasoning, and tool sequences below  | root's next provider step
 *   v                                             |
 * finish-step ------------------------------------+
 *   |  all Parts terminal; commit usage + step marker
 *   v
 * finish -> stream ends -> cleanup -> return to Prompt
 * ```
 *
 * Within a step, these sequences may interleave. Each keeps its own id:
 *
 * ```
 * reasoning-start -> reasoning-delta* -> reasoning-end
 * text-start      -> text-delta*      -> text-end
 *                    live updates       final persisted text
 *
 * tool-input-start -> [tool-input-delta* -> tool-input-end]
 *   | pending         input fragments are ignored
 *   | commit releases the bound tool callback's waiter
 *   v
 * tool-call (owns the complete input)
 *   +-- valid input -> running -> tool-result (completed)
 *   |                          -> tool-error  (error)
 *   `-- invalid input ---------> error (paired tool-error is ignored)
 * ```
 *
 * Prompt/SDK callbacks execute tools; these events record their lifecycle.
 * Each delegate has one step in its own Message and must finish before its
 * parent's proxy tool result/error. Only the root can repeat provider steps.
 * finish is a request boundary; usage is counted only at finish-step.
 * Unrecoverable failure or cancellation skips the normal ending: cleanup
 * closes active Parts, seals unfinished Messages, and releases tool waiters.
 * Every exit runs cleanup. Prompt owns the next-turn decision after success.
 */

/** Opens the model request; creates no transcript Part. */
export const EVENT_START = "start" as const;
/** Closes the model request; adds no usage beyond finish-step. */
export const EVENT_FINISH = "finish" as const;
/** Creates an empty text Part for this stream id. */
export const EVENT_TEXT_START = "text-start" as const;
/** Appends text and publishes or persists the updated Part. */
export const EVENT_TEXT_DELTA = "text-delta" as const;
/** Persists final text and closes the active text Part. */
export const EVENT_TEXT_END = "text-end" as const;
/** Creates an empty reasoning Part for this stream id. */
export const EVENT_REASONING_START = "reasoning-start" as const;
/** Appends reasoning and publishes or persists the updated Part. */
export const EVENT_REASONING_DELTA = "reasoning-delta" as const;
/** Persists final reasoning and closes the active reasoning Part. */
export const EVENT_REASONING_END = "reasoning-end" as const;
/** Commits a pending ToolPart before releasing its callback waiter. */
export const EVENT_TOOL_INPUT_START = "tool-input-start" as const;
/** Carries an input fragment; executable input comes from tool-call. */
export const EVENT_TOOL_INPUT_DELTA = "tool-input-delta" as const;
/** Ends input streaming without executing or completing the tool. */
export const EVENT_TOOL_INPUT_END = "tool-input-end" as const;
/** Records complete input and moves the tool to running or input error. */
export const EVENT_TOOL_CALL = "tool-call" as const;
/** Completes a running tool with its result. */
export const EVENT_TOOL_RESULT = "tool-result" as const;
/** Fails a running tool; a paired error for invalid input is ignored. */
export const EVENT_TOOL_ERROR = "tool-error" as const;
/** Opens a destination step and commits its start marker. */
export const EVENT_START_STEP = "start-step" as const;
/** Requires terminal Parts, then commits step usage and its finish marker. */
export const EVENT_FINISH_STEP = "finish-step" as const;
