// Purpose: Own the profile's native notification sound preference and its default.
import { notificationSoundIds } from "@openchart/notification";
import { Config, Effect, Schema } from "effect";

/** One global sound choice; selecting none keeps visual notification delivery. */
export const NotificationSettings = Schema.Struct({
  sound: Schema.Literals(notificationSoundIds).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("chime" as const)),
  ),
});

/** Reads the current Config snapshot at delivery, so changes need no restart. */
export const config = Config.schema(
  Schema.Struct({
    notifications: NotificationSettings.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
  }),
).pipe(Config.map((value) => value.notifications));
