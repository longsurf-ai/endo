// Purpose: Shares settled-history selection and copying between fork and Dig In.
import type { WithParts } from "@openchart/server/agent/contracts/message";
import type { SessionId } from "@openchart/server/agent/contracts/session";
import { ascending } from "@openchart/identifier";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { assertExists } from "@openchart/utils/assert";
import { Effect } from "effect";
import { BranchUnavailable } from "@openchart/server/agent/session/errors";
import type { SessionStore } from "@openchart/server/agent/session/store";
import { readHistoryThrough } from "./read-history-through";

/**
 * Reads settled history through a visible Assistant reply inside a branch transaction.
 * Rejects Dig In sources and copied markers to prevent recursive Dig In history.
 * @example const source = yield* readBranchSource(tx, sessionID, messageID);
 */
export const readBranchSource = Effect.fn("Session.readBranchSource")(
  function* (tx: SessionStore.Tx, sessionID: SessionId, messageID: string) {
    const { source, history } = yield* readHistoryThrough(
      tx,
      sessionID,
      messageID,
    );
    const target = history.at(-1);
    assertExists(target, "A non-null history boundary must retain its Message");
    if (
      source.kind === "dig_in" ||
      history.some(({ parts }) =>
        parts.some(
          (part) => part.type === "context" && part.context.kind === "dig_in",
        ),
      ) ||
      target.info.role !== "assistant" ||
      !target.parts.some(
        (part) => part.type === "text" && !part.synthetic && part.text.trim(),
      ) ||
      history.some(hasUnfinishedWork)
    )
      return yield* new BranchUnavailable();

    return { source, target, history };
  },
);

function hasUnfinishedWork({ info, parts }: WithParts) {
  return (
    (info.role === "assistant" && info.time.completed === undefined) ||
    parts.some(
      (part) =>
        part.type === "tool" &&
        (part.state.status === "pending" || part.state.status === "running"),
    )
  );
}

/**
 * Copies transcript facts with fresh Message/Part IDs and remapped local references.
 * Does not copy Runs, bindings, approvals, or publish partial history.
 * @example yield* copyHistory(tx, history, child.id);
 */
export const copyHistory = Effect.fn("Session.copyHistory")(function* (
  tx: SessionStore.Tx,
  history: readonly WithParts[],
  sessionID: SessionId,
) {
  const messageIDs = new Map(
    history.map(({ info }) => [info.id, `msg_${ascending()}`]),
  );
  const partIDs = new Map(
    history.flatMap(({ parts }) =>
      parts.map((part) => [part.id, `prt_${ascending()}`] as const),
    ),
  );
  for (const message of history) {
    const { info, parts } = structuredClone(message);
    info.id = messageIDs.get(info.id)!;
    info.sessionID = sessionID;
    if (info.role === "assistant")
      info.triggeringUserMessageID = messageIDs.get(
        info.triggeringUserMessageID,
      )!;
    for (const part of parts) {
      part.id = partIDs.get(part.id)!;
      part.messageID = info.id;
      if (part.type === "evidence")
        part.sourcePartID = partIDs.get(part.sourcePartID) ?? part.sourcePartID;
      if (part.type === "tool" && part.state.status === "completed")
        for (const file of part.state.attachments ?? []) {
          file.id = `prt_${ascending()}`;
          file.messageID = info.id;
        }
    }
    yield* messageStore.insert(tx, { info, parts });
  }
});
