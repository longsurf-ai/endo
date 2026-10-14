// Purpose: Exposes Session and transcript operations with their inferred Effect requirements.

export * as Session from "./session";

import { get } from "@openchart/server/agent/session/operations/get";
import { list } from "@openchart/server/agent/session/operations/list";
import { readTranscriptPage } from "@openchart/server/agent/session/operations/read-transcript-page";
import { readSnapshot } from "@openchart/server/agent/session/operations/read-snapshot";
import { searchTranscripts } from "@openchart/server/agent/session/operations/search-transcripts";
import { create } from "@openchart/server/agent/session/operations/create";
import { fork } from "@openchart/server/agent/session/operations/fork";
import { truncate } from "@openchart/server/agent/session/operations/truncate";
import { digIn } from "@openchart/server/agent/session/operations/dig-in";
import { getOrCreateBound } from "@openchart/server/agent/session/operations/get-or-create-bound";
import { getSessionByBinding } from "@openchart/server/agent/session/operations/get-session-by-binding";
import { update } from "@openchart/server/agent/session/operations/update";
import { markRead } from "@openchart/server/agent/session/operations/mark-read";
import { archive } from "@openchart/server/agent/session/operations/archive";
import { getMessage } from "@openchart/server/agent/session/operations/get-message";
import { listMessages } from "@openchart/server/agent/session/operations/list-messages";
import { createMessage } from "@openchart/server/agent/session/operations/create-message";
import { updateMessage } from "@openchart/server/agent/session/operations/update-message";
import { getPart } from "@openchart/server/agent/session/operations/get-part";
import { createPart } from "@openchart/server/agent/session/operations/create-part";
import { createParts } from "@openchart/server/agent/session/operations/create-parts";
import { updatePart } from "@openchart/server/agent/session/operations/update-part";
import { finishStep } from "@openchart/server/agent/session/operations/finish-step";
import { interruptUnfinished } from "@openchart/server/agent/session/operations/interrupt-unfinished";
import { Context, Layer } from "effect";

import { bindExisting } from "./operations/bind-existing";

const operations = {
  bindExisting,
  get,
  list,
  readTranscriptPage,
  readSnapshot,
  searchTranscripts,
  create,
  fork,
  truncate,
  digIn,
  getOrCreateBound,
  getSessionByBinding,
  update,
  markRead,
  archive,
  getMessage,
  listMessages,
  createMessage,
  updateMessage,
  getPart,
  createPart,
  createParts,
  updatePart,
  finishStep,
  interruptUnfinished,
};

/** Session and transcript operations with their original errors and requirements. */
export type Interface = Readonly<typeof operations>;

/**
 * Unified data-operation entry; one service handles all Session IDs.
 * @example
 * const session = yield* Session.Service;
 * const info = yield* session.create();
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Session",
) {}

/**
 * Provides the operation API without acquiring dependencies. Each operation
 * resolves its own services when executed; snapshot reads also use Run and
 * Permission services, while transcript reads need only Database.
 * @example
 * const sessions = Session.layer;
 */
export const layer = Layer.succeed(Service, operations);
