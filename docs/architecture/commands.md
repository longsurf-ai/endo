# Slash commands

`server/agent/command/commands/` owns one definition per file. Each definition
uses `defineCommand` with `name`, `type`, `description`, `template`, `buildParts`,
and `restoreArgumentsFromParts`.
`catalog.ts` explicitly registers definitions and rejects duplicate names.

`template.ts` owns argument tokenization and expansion. `$1`, `$2`, etc.
capture positional arguments; the highest numbered placeholder captures the
remaining arguments joined with spaces. Quotes group one argument and are
removed. Missing arguments become empty strings. `$ARGUMENTS` substitutes the
raw argument text. With no placeholders, nonempty arguments append to the
template after two newlines. The expanded string is trimmed.

Expansion also retains placeholder values for `buildParts`. Builders and inverses
are pure; their schemas own command argument validation. Workflow commands declare
these schemas locally and never import workflow programs or execution schemas. Shell interpolation and file loading
are outside this argument compiler.

`defineCommand` exposes checked operations and keeps the raw callbacks private.
Before construction returns Parts, it restores their arguments and recompiles
through the same template/builder, requiring deep equality of all fields and order.
The restore operation enforces the same equality. Internal compilation never calls
the checked build method recursively. Invalid initial arguments retain their schema
failure; an inverse that cannot restore the command's own output is an internal
defect. Unsupported external Parts fail restoration. This checks each actual
conversion; it is not a static proof over every possible input. Round-trip tests
cover the supported domain and parser edge cases.

The Agent tRPC API exposes:

- `agent.commands`: returns `{name, type, description, hints, argumentHint?}[]`, with
  `hints` derived from templates and optional display-only `argumentHint` authored
  by each command. Executable builders remain on the server.
- `agent.buildCommand`: accepts only `{command, arguments}` and returns
  `AgentPromptPartInput[]`. It validates command arguments and constructs Parts
  without creating a Session, persisting a Run, or waking execution.
- `agent.restoreCommand`: accepts one composer-generated command Part and returns
  canonical `{command, arguments}` for editing. Each definition owns its inverse;
  restoration recompiles and deeply compares the Part before returning. Unsupported
  or lossy input fails. This operation also has no admission or execution effects.

The returned Parts are ordinary JSON data; no functions or Effect values cross
the wire. Callers combine them with other input Parts and agent/model/workspace
fields, then submit through `agent.prompt` with a Session ID and submission
intent ID. This remains the sole prompt submission API and validates the complete
AgentPromptInput, including constraints across Parts. Construction has no
admission or execution side effects.

Runs store only the canonical prompt snapshot. The existing intent check rejects
reuse with different input; it never silently reinterprets an accepted Run.
SessionExecution, Runner and Prompt retain all execution ownership.

`compact` emits `{type: 'compaction', auto: false}`. Submitting that Part through
`agent.prompt` invokes the existing manual compaction path. It takes no arguments;
command arguments are rejected instead of discarded. Accompanying context Parts
are included in the summary input and retained with the marker User message.
Manual compaction ends after the summary; sibling text does not start another task.
`best-of-n` uses `$1 $2` and emits a `default:workflows/best-of-n.workflow.ts` WorkflowPart with
`{n, question}`. n must be a positive integer and the question must be nonempty.
The workflow creates n fresh researchers and one summarizer under the existing
concurrency bound, sharing the root Run and cancellation scope.
`multi-turn-debate` also uses `$1 $2` and emits a `default:workflows/multi-turn-debate.workflow.ts`
WorkflowPart with `{round, topic}`. The round count must be a positive integer
and the topic must be nonempty. Two agents alternate affirmative/negative statements for
the requested rounds, then a fresh summarizer receives the complete debate.
All three use the model selected in the parent prompt.

`thesis-killer` and `hypothesis-race` use `$ARGUMENTS` and emit their file-based
`default:workflows/thesis-killer.workflow.ts` / `default:workflows/hypothesis-race.workflow.ts` WorkflowParts with `{thesis}` / `{question}`.
Both require nonblank text and preserve quotes and line breaks when editing.
Every agent call uses structured output and the parent model. Decomposition is
schema-bounded to one through five items. Thesis Killer challenges critical
assumptions and reviews observable invalidation conditions; Hypothesis Race
compares competing explanations and may investigate one discriminating question.
For example: `/thesis-killer Remote work improves team productivity over three years` or
`/hypothesis-race Why did signups drop after the redesign?`.

The app reads this catalog through React Query. `type` (`workflow` or
`compaction`) selects the menu icon; command names are never hardcoded in the
composer. The assistant-ui menu and trigger primitives own selection
and keyboard navigation. Selecting a command inserts an assistant-ui Directive chip;
arguments remain editable text. Selection does not execute or submit anything.
The menu and an isolated composer hint display `argumentHint`. The hint derives
the leading command name from the assistant-ui draft; it owns no draft state,
argument validation, or submission behavior.

Version one recognizes one command chip or typed slash command at the very
beginning of the draft. Its
remaining text is a single raw argument string, including any later slashes.
`toPromptParts` calls an injected `buildCommand` before the existing submission
mutation sends `agent.prompt`. Ordinary text and quotes retain their ordering;
unknown commands or invalid arguments reject construction and preserve the draft.

`fromPromptParts` reverses the composer-produced subset: optional quote, text or
one command, then completed images. It delegates command restoration through an
injected callback and restores a native command chip with editable arguments.
Quote source IDs, attachment IDs, and browser File objects are editor-only;
ordinary text and canonical Parts round-trip without changes. Original command
spelling, labels, and argument formatting need not survive compilation. Parts
outside this subset fail instead of being silently flattened or dropped.
