// Purpose: Owns expected slash-command lookup and argument failures.
import { Schema } from "effect";

/** The requested command is absent from this server's catalog. */
export class UnknownCommand extends Schema.TaggedError<UnknownCommand>()(
  "Command.Unknown",
  { name: Schema.String },
) {}

/** Command arguments violate their owning schema. */
export class InvalidCommandInput extends Schema.TaggedError<InvalidCommandInput>()(
  "Command.InvalidInput",
  { name: Schema.String, detail: Schema.String },
) {}

/** No registered command can reproduce this Part without information loss. */
export class UnsupportedCommandPart extends Schema.TaggedError<UnsupportedCommandPart>()(
  "Command.UnsupportedPart",
  {},
) {}
