# Error model

Domain owners define failures. `server/lib/errors/failureFor` classifies them
once for public transport and logging. Transport handlers do not add their own
business-error classifiers.

Known domain failures expose only their public message and structured details.
A domain that needs typed client handling encodes a `{code, message}` public error
at `details.error`; tRPC places it at `data.error`. Causes and internal diagnostics
remain local to the backend.

Status tables are exhaustive over the public reason tags and use tRPC's status
vocabulary. Unknown failures and wiring defects become internal errors. The
classifier reports them once per failing operation. Transport wrappers preserve
the original cause and mark already-classified failures so formatting does not
classify or report them again.

Native protocol errors retain their status without exposing raw parser inputs.
An unavailable data source stays an error; it must not become an empty result or
an invented successful state. UI owners preserve drafts and distinguish query
failures from successful mutations followed by a failed refresh.

Read [the classifier's ownership rules](../../server/lib/errors/AGENTS.md)
before changing error behavior.
