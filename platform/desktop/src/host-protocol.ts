// Purpose: Define the four parentPort messages between Electron main and the backend process.

import { z } from "zod";
import { notificationSoundIds } from "@openchart/notification";

/** First message after fork: this run's secrets and paths. Secrets travel here, never in argv. */
export const Init = z.object({
  type: z.literal("init"),
  /** Per-run API token; every renderer request presents it. */
  token: z.string().min(1),
  home: z.string().min(1),
  /** The only Origin the backend accepts. */
  rendererOrigin: z.string().min(1),
});
export type Init = z.infer<typeof Init>;

/** Asks the backend to run server.shutdown() and exit 0. */
export const Shutdown = z.object({ type: z.literal("shutdown") });

/** Everything main may post to the backend. @example const message = HostMessage.parse(event.data); */
export const HostMessage = z.discriminatedUnion("type", [Init, Shutdown]);
export type HostMessage = z.infer<typeof HostMessage>;

/** Sent once the backend listens; main opens windows only after it. @example const {port} = Ready.parse(message); */
export const Ready = z.object({
  type: z.literal("ready"),
  port: z.number().int().min(1).max(65535),
});
export type Ready = z.infer<typeof Ready>;

/** Asks main to display one system notification; the backend owns the wording. @example const {title, body} = Notify.parse(message); */
export const Notify = z.object({
  type: z.literal("notify"),
  title: z.string().min(1),
  body: z.string(),
  sound: z.enum(notificationSoundIds),
});
export type Notify = z.infer<typeof Notify>;

/** Everything the backend may post to main. @example const message = BackendMessage.safeParse(data); */
export const BackendMessage = z.discriminatedUnion("type", [Ready, Notify]);
export type BackendMessage = z.infer<typeof BackendMessage>;
