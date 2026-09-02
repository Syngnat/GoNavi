import { describe, expect, it } from 'vitest';

import {
  AIRunEventSequenceTracker,
  normalizeAIRunToolIntent,
  parseAIRunEvent,
  toAIRunToolCalls,
  type AIRunEvent,
} from './aiRunEventProjection';

const event = (sequence: number, overrides: Partial<AIRunEvent> = {}): AIRunEvent => ({
  schemaVersion: 1,
  runId: 'run-1',
  sessionId: 'session-1',
  sessionGeneration: 1,
  sequence,
  runRevision: sequence,
  attempt: 1,
  timestamp: '2026-09-01T00:00:00Z',
  kind: 'model_delta',
  resultingState: 'running_model',
  payload: { text: 'hello' },
  ...overrides,
});

describe('AI run event projection contract', () => {
  it('parses object and RawMessage string payloads', () => {
    expect(parseAIRunEvent(event(1))).toMatchObject({
      runId: 'run-1',
      sequence: 1,
      payload: { text: 'hello' },
    });
    expect(parseAIRunEvent({
      ...event(2),
      payload: JSON.stringify({ text: ' world' }),
    })).toMatchObject({ payload: { text: ' world' } });
  });

  it('decodes Wails byte-array payloads and complete byte-array events', () => {
    const payload = Array.from(new TextEncoder().encode(JSON.stringify({ text: 'bytes' })));
    expect(parseAIRunEvent({
      ...event(1),
      payload,
    })).toMatchObject({ payload: { text: 'bytes' } });

    const encodedEvent = Array.from(new TextEncoder().encode(JSON.stringify({
      ...event(2),
      payload: { text: 'whole-event' },
    })));
    expect(parseAIRunEvent(encodedEvent)).toMatchObject({
      sequence: 2,
      payload: { text: 'whole-event' },
    });

    const numericKeyEvent = Object.fromEntries(
      encodedEvent.map((byte, index) => [String(index), byte]),
    );
    expect(parseAIRunEvent(numericKeyEvent)).toMatchObject({
      sequence: 2,
      payload: { text: 'whole-event' },
    });

    const typedEvent = new Uint16Array(encodedEvent);
    expect(parseAIRunEvent(typedEvent)).toBeNull();
  });

  it('rejects unknown schemas, malformed payloads, and zero sequences', () => {
    expect(parseAIRunEvent({ ...event(1), schemaVersion: 2 })).toBeNull();
    expect(parseAIRunEvent({ ...event(1), payload: '{' })).toBeNull();
    expect(parseAIRunEvent(event(0))).toBeNull();
    // `interrupted` remains resumable. It must be communicated through a
    // checkpoint/error event, never as the one terminal event for a run.
    expect(parseAIRunEvent({
      ...event(1),
      kind: 'terminal',
      resultingState: 'interrupted',
      payload: { reason: 'shutdown' },
    })).toBeNull();
  });

  it('accepts an interrupted state checkpoint with Go\'s empty checkpoint ID', () => {
    expect(parseAIRunEvent({
      ...event(1),
      kind: 'checkpoint',
      resultingState: 'interrupted',
      payload: { checkpointId: '', sequence: 1 },
    })).toMatchObject({
      kind: 'checkpoint',
      resultingState: 'interrupted',
      payload: { checkpointId: '', sequence: 1 },
    });
  });

  it('rejects coerced identifiers and unknown tool effects', () => {
    expect(parseAIRunEvent({ ...event(1), runId: 42 })).toBeNull();
    expect(parseAIRunEvent({ ...event(1), kind: ['model_delta'] })).toBeNull();
    expect(parseAIRunEvent({
      ...event(1),
      payload: {
        toolCalls: [{
          callId: 'call-1',
          toolName: 'execute_sql',
          effect: 'write_everything',
          arguments: {},
        }],
      },
    })).toBeNull();
    expect(normalizeAIRunToolIntent({
      callId: 1,
      toolName: 'execute_sql',
      arguments: {},
    })).toBeNull();
  });

  it('deduplicates, reports gaps without advancing, and drops terminal callbacks', () => {
    const tracker = new AIRunEventSequenceTracker();

    expect(tracker.observe(event(1)).disposition).toBe('accepted');
    expect(tracker.observe(event(1)).disposition).toBe('duplicate');
    expect(tracker.observe(event(3))).toMatchObject({
      disposition: 'gap',
      afterSequence: 1,
    });
    expect(tracker.lastSequence('run-1')).toBe(1);
    expect(tracker.observe(event(2)).disposition).toBe('accepted');
    expect(tracker.observe(event(3, {
      kind: 'terminal',
      resultingState: 'completed',
      payload: { reason: 'completed' },
    })).disposition).toBe('accepted');
    expect(tracker.observe(event(4))).toMatchObject({ disposition: 'late_terminal' });
  });

  it('converts typed tool intents without leaking malformed calls', () => {
    expect(toAIRunToolCalls({
      toolCalls: [
        { callId: 'call-1', toolName: 'execute_sql', arguments: { sql: 'SELECT 1' } },
        { callId: '', toolName: 'ignored', arguments: {} },
      ],
    })).toEqual([{
      id: 'call-1',
      type: 'function',
      function: {
        name: 'execute_sql',
        arguments: JSON.stringify({ sql: 'SELECT 1' }),
      },
    }]);
  });

  it('drops invalid JSON, duplicate IDs, and array-root arguments', () => {
    expect(toAIRunToolCalls({
      toolCalls: [
        { callId: 'bad-json', toolName: 'execute_sql', arguments: '{"sql":' },
        { callId: 'primitive', toolName: 'execute_sql', arguments: '42' },
        { callId: 'call-1', toolName: 'execute_sql', arguments: '{"sql":"SELECT 1"}' },
        { callId: 'call-1', toolName: 'execute_sql', arguments: '{"sql":"SELECT 2"}' },
        { callId: 'call-2', toolName: 'read_schema', arguments: ['public'] },
      ],
    })).toEqual([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'execute_sql', arguments: '{"sql":"SELECT 1"}' },
      },
    ]);
  });

  it('normalizes nested RawMessage arguments and rejects malformed byte-shaped values', () => {
    const encodedArguments = new Uint8Array(new TextEncoder().encode('{"sql":"SELECT 3"}'));
    expect(normalizeAIRunToolIntent({
      callId: 'call-bytes',
      toolName: 'execute_sql',
      arguments: encodedArguments,
    })).toMatchObject({
      callId: 'call-bytes',
      arguments: { sql: 'SELECT 3' },
    });

    expect(toAIRunToolCalls({
      toolCalls: [{
        callId: 'call-malformed-bytes',
        toolName: 'execute_sql',
        arguments: [255, 0, 1],
      }],
    })).toEqual([]);
  });
});
