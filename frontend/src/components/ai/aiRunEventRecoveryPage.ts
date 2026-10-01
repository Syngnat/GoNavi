import {
  parseAIRunEvent,
  readAIRunEventCursor,
  type AIRunEvent,
  type AIRunState,
} from './aiRunEventProjection';

/** One durable Ledger event of a recovery read; `event` is null when unreadable. */
export interface AIRunRecoveryItem {
  sequence: number;
  event: AIRunEvent | null;
}

/**
 * Orders a Ledger page by sequence and keeps events the projection cannot
 * validate as placeholders. Dropping them would leave a permanent gap: every
 * later event would be buffered and each retry would re-read the same page.
 */
export const parseAIRunRecoveryPage = (rawEvents: unknown, runId: string): AIRunRecoveryItem[] => {
  const bySequence = new Map<number, AIRunRecoveryItem>();
  for (const raw of Array.isArray(rawEvents) ? rawEvents : []) {
    const event = parseAIRunEvent(raw);
    if (event) {
      bySequence.set(event.sequence, { sequence: event.sequence, event });
      continue;
    }
    const cursor = readAIRunEventCursor(raw);
    if (cursor && cursor.runId === runId && !bySequence.has(cursor.sequence)) {
      bySequence.set(cursor.sequence, { sequence: cursor.sequence, event: null });
    }
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
};

/**
 * A terminal Ledger snapshot is authoritative but has no durable event payload
 * to consume, so it is projected as a synthetic terminal event that takes the
 * next cursor position. Delayed runtime callbacks then stay late.
 */
export const buildAIRunSnapshotTerminalEvent = (params: {
  runId: string;
  sessionId: string;
  snapshot: Record<string, unknown> | undefined;
  state: AIRunState;
  lastSequence: number;
}): AIRunEvent => {
  const { runId, sessionId, snapshot, state, lastSequence } = params;
  const revision = Number(snapshot?.revision);
  const attempt = Number(snapshot?.attempt);
  const sessionGeneration = Number(snapshot?.sessionGeneration);
  const updatedAt = snapshot?.updatedAt;
  return {
    schemaVersion: 1,
    runId,
    sessionId,
    sessionGeneration: Number.isSafeInteger(sessionGeneration) && sessionGeneration >= 0
      ? sessionGeneration
      : 0,
    sequence: lastSequence + 1,
    runRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : lastSequence,
    attempt: Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0,
    timestamp: typeof updatedAt === 'string' || typeof updatedAt === 'number' ? updatedAt : Date.now(),
    kind: 'terminal',
    resultingState: state,
    payload: {
      reason: String(snapshot?.terminalReason || state),
    },
  };
};
