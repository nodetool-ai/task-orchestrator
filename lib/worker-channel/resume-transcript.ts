import { MAX_JSON_FRAME_BYTES, type RunStart } from "./protocol";

/** Leave room for the envelope and future bootstrap fields below the 1 MiB
 * channel limit. This is a UTF-8 byte budget, not a message or character count. */
export const RESUME_SNAPSHOT_BYTES = 512 * 1024;

/** Bound the transcript copy for a continuation. With an SDK token it is
 * redundant; without one it is the recovery context, so retain the newest
 * coherent suffix that fits. The database remains the complete record.
 * Never trim fresh starts, pending input, or the latest agent reply and
 * anything after it (the legacy input cursor).
 *
 * Pure and deterministic so an oversized command persisted by an older server
 * can use the same wire representation on every retry without rewriting its
 * durable payload or changing the input manifest.
 */
export function boundResumeTranscript(start: RunStart): RunStart {
  if (start.mode !== "resume") return start;
  if (Buffer.byteLength(JSON.stringify(start), "utf8") <= RESUME_SNAPSHOT_BYTES) return start;

  const lastAgent = start.transcript.findLastIndex((message) => message.role === "agent");
  if (lastAgent <= 0) return start;

  // Reserve the largest possible omission counter before measuring. Keeping
  // more messages can only shorten it, so the final snapshot stays in budget.
  const priorOmitted = start.transcriptOmittedMessages ?? 0;
  let bytes = Buffer.byteLength(JSON.stringify({
    ...start,
    transcriptOmittedMessages: priorOmitted + lastAgent,
  }), "utf8");
  let omitted = 0;
  while (bytes > RESUME_SNAPSHOT_BYTES && omitted < lastAgent) {
    bytes -= Buffer.byteLength(JSON.stringify(start.transcript[omitted]), "utf8") + 1;
    omitted++;
  }
  // The target is soft when the protected suffix/input itself needs more room;
  // still reserve 4 KiB for the command envelope. Input too large even for the
  // transport limit must be reported by the validator, never silently dropped.
  if (bytes > MAX_JSON_FRAME_BYTES - 4096) return start;
  return {
    ...start,
    transcript: start.transcript.slice(omitted),
    transcriptOmittedMessages: priorOmitted + omitted,
  };
}
