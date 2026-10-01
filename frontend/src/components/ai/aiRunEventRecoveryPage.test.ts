import { describe, expect, it } from 'vitest';

import { AIRunEventSequenceTracker, readAIRunEventCursor } from './aiRunEventProjection';
import { buildAIRunSnapshotTerminalEvent, parseAIRunRecoveryPage } from './aiRunEventRecoveryPage';

const raw = (sequence: number, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  runId: 'run-1',
  sessionId: 'session-1',
  sessionGeneration: 1,
  sequence,
  runRevision: sequence,
  attempt: 1,
  timestamp: '2026-09-30T00:00:00Z',
  kind: 'model_delta',
  resultingState: 'running_model',
  payload: { text: `chunk-${sequence}` },
  ...overrides,
});

// A completed-turn style payload the parser rejects (unknown tool effect).
const unreadable = (sequence: number) => raw(sequence, {
  payload: { toolCalls: [{ callId: 'c', toolName: 'execute_sql', effect: 'write_everything' }] },
});

describe('AI run recovery page', () => {
  it('keeps unreadable events as ordered placeholders instead of dropping them', () => {
    const items = parseAIRunRecoveryPage([raw(3), unreadable(2), raw(1)], 'run-1');

    expect(items.map((item) => [item.sequence, item.event === null])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it('ignores placeholders that belong to another run or have no readable envelope', () => {
    const items = parseAIRunRecoveryPage([
      { ...unreadable(1), runId: 'run-other' },
      'not-json{',
      { sequence: 'x', runId: 'run-1' },
      raw(2),
    ], 'run-1');

    expect(items.map((item) => item.sequence)).toEqual([2]);
  });

  it('lets the cursor step over only the next contiguous unreadable sequence', () => {
    const tracker = new AIRunEventSequenceTracker();

    expect(tracker.skipUnreadable('run-1', 2)).toBe(false);
    expect(tracker.skipUnreadable('run-1', 1)).toBe(true);
    expect(tracker.lastSequence('run-1')).toBe(1);
    expect(tracker.skipUnreadable('run-1', 1)).toBe(false);
    expect(tracker.skipUnreadable('run-1', 2)).toBe(true);
  });

  it('never advances a terminal run', () => {
    const tracker = new AIRunEventSequenceTracker();
    tracker.observe({
      ...raw(1, { kind: 'terminal', resultingState: 'completed', payload: { reason: 'completed' } }),
    } as never);

    expect(tracker.skipUnreadable('run-1', 2)).toBe(false);
  });

  it('reads the cursor from RawMessage-encoded events', () => {
    expect(readAIRunEventCursor(JSON.stringify(unreadable(7)))).toEqual({ runId: 'run-1', sequence: 7 });
    expect(readAIRunEventCursor(raw(0))).toBeNull();
  });

  it('builds a terminal event that takes the next cursor position', () => {
    const event = buildAIRunSnapshotTerminalEvent({
      runId: 'run-1',
      sessionId: 'session-1',
      snapshot: { revision: 9, attempt: 2, sessionGeneration: 3, terminalReason: 'completed' },
      state: 'completed',
      lastSequence: 4,
    });

    expect(event).toMatchObject({
      sequence: 5,
      runRevision: 9,
      attempt: 2,
      sessionGeneration: 3,
      kind: 'terminal',
      resultingState: 'completed',
      payload: { reason: 'completed' },
    });
  });
});
