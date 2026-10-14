// Purpose: Assigns durable evidence identities and bounds the exact content exposed to models.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  EvidenceCandidate,
  EvidencePart,
  Part,
} from "@openchart/server/agent/contracts/part";
import { ascending } from "@openchart/identifier";
import { assertTrue } from "@openchart/utils/assert";

/**
 * Serializes the committed evidence blocks with their model citation references.
 * @example
 * const output = serializeEvidenceBank(parts, omittedCount);
 */
export function serializeEvidenceBank(
  parts: readonly Pick<EvidencePart, "evidenceID" | "source" | "blocks">[],
  omittedEvidenceCount = 0,
) {
  return JSON.stringify(
    {
      evidence: parts.map((part) => ({
        evidenceId: part.evidenceID,
        source: part.source,
        blocks: part.blocks.map((block) => ({
          ...block,
          reference: `${part.evidenceID}#${block.id}`,
        })),
      })),
      ...(omittedEvidenceCount > 0 ? { omittedEvidenceCount } : {}),
    },
    null,
    2,
  );
}

/**
 * Prepares bounded evidence without writing. The caller commits these Parts
 * before exposing modelOutput; references and hashes describe those exact bytes.
 * @example
 * const prepared = prepareEvidence(candidates, sourcePart, now);
 * for (const part of prepared.parts) yield* session.createPart(part);
 */
export function prepareEvidence(
  candidates: readonly EvidenceCandidate[],
  source: Pick<Part, "id" | "messageID">,
  capturedAt: number,
) {
  const parts: EvidencePart[] = [];
  for (const candidate of candidates) {
    const blocks = candidate.blocks.map((block, index) => ({
      id: `b${index}`,
      kind: block.kind,
      text: block.text.slice(0, 3000),
      truncated: block.text.length > 3000,
    }));
    const part: EvidencePart = {
      id: `prt_${ascending()}`,
      messageID: source.messageID,
      type: "evidence",
      evidenceID: `evd_${ascending()}`,
      sourcePartID: source.id,
      capturedAt,
      source: candidate.source,
      blocks,
      contentHash: createHash("sha256")
        .update(JSON.stringify({ source: candidate.source, blocks }))
        .digest("hex"),
    };
    const output = serializeEvidenceBank(
      [...parts, part],
      candidates.length - parts.length - 1,
    );
    if (Buffer.byteLength(output, "utf8") > 40 * 1024) break;
    parts.push(part);
  }
  assertTrue(
    candidates.length === 0 || parts.length > 0,
    "At least one bounded evidence candidate must fit the model output budget",
  );
  return {
    parts,
    modelOutput: serializeEvidenceBank(parts, candidates.length - parts.length),
  };
}
