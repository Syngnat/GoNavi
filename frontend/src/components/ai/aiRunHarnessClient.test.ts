import { describe, expect, it, vi } from 'vitest';

import {
  controlAgentRun,
  hasAIRunHarness,
  normalizeAgentLedgerState,
  parseToolCalls,
  serializeShortcutOptionsForWorkspace,
  submitAgentInput,
  toAIChatMessages,
  mergeAIChatSessionMessages,
} from './aiRunHarnessClient';

describe('AI run harness client', () => {
  it('exposes typed input and control calls without depending on generated bindings', async () => {
    const AISubmitAgentInput = vi.fn().mockResolvedValue({
      requestId: 'request-1',
      sessionId: 'session-1',
      runId: 'run-1',
      disposition: 'started',
      revision: 1,
      state: 'queued',
    });
    const AIControlAgentRun = vi.fn().mockResolvedValue({ runId: 'run-1', state: 'canceled' });
    const service = { AISubmitAgentInput, AIControlAgentRun };

    expect(hasAIRunHarness(service)).toBe(true);
    await expect(submitAgentInput({ requestId: 'request-1', content: 'hello' }, service)).resolves.toMatchObject({
      runId: 'run-1',
    });
    await controlAgentRun({ requestId: 'request-2', runId: 'run-1', action: 'cancel' }, service);
    expect(AISubmitAgentInput).toHaveBeenCalledWith({ requestId: 'request-1', content: 'hello' });
    expect(AIControlAgentRun).toHaveBeenCalledWith({ requestId: 'request-2', runId: 'run-1', action: 'cancel' });
  });

  it('fails explicitly when the new backend is not available', async () => {
    expect(hasAIRunHarness({})).toBe(false);
    await expect(submitAgentInput({ requestId: 'request-1', content: 'hello' }, {}))
      .rejects.toThrow('AISubmitAgentInput is unavailable');
  });

  it('projects only the stable, non-sensitive ledger state', () => {
    expect(normalizeAgentLedgerState({ state: 'ready', ignored: '/private/agent_runs.sqlite' })).toBe('ready');
    expect(normalizeAgentLedgerState({ state: 'locked', ignored: 'key-material' })).toBe('locked');
    expect(normalizeAgentLedgerState({ state: 'unexpected' })).toBe('unavailable');
    expect(normalizeAgentLedgerState(null)).toBe('unavailable');
  });

  it('decodes RawMessage byte arrays returned by Wails before projecting tool calls', () => {
    const rawCalls = JSON.stringify([{
      callId: 'call-1',
      toolName: 'execute_sql',
      arguments: { sql: 'select 1' },
    }]);
    const bytes = Array.from(new TextEncoder().encode(rawCalls));
    const [message] = toAIChatMessages({
      messages: [{
        id: 'assistant-1',
        runId: 'run-1',
        role: 'assistant',
        content: '',
        toolCalls: bytes,
      }],
    });

    expect(message.runId).toBe('run-1');
    expect(message.tool_calls).toEqual([{
      id: 'call-1',
      type: 'function',
      function: { name: 'execute_sql', arguments: '{"sql":"select 1"}' },
    }]);
  });

  it('decodes typed-array arguments and ignores malformed RawMessage values', () => {
    const args = new TextEncoder().encode('{"sql":"select 2"}');
    const calls = parseToolCalls(new Uint8Array(new TextEncoder().encode(JSON.stringify([{
      id: 'call-2',
      name: 'execute_sql',
      arguments: args,
    }]))));
    expect(calls?.[0]?.function.arguments).toBe('{"sql":"select 2"}');
    expect(parseToolCalls([255, 0, 1])).toBeUndefined();
  });

  it('merges assistant turns from one run while retaining tool messages', () => {
    expect(toAIChatMessages({
      messages: [
        { id: 'assistant-1', runId: 'run-1', role: 'assistant', content: 'first', createdAt: 1 },
        { id: 'tool-1', runId: 'run-1', role: 'tool', toolCallId: 'call-1', toolName: 'inspect', content: '{"ok":true}', createdAt: 2 },
        { id: 'assistant-2', runId: 'run-1', role: 'assistant', content: 'second', createdAt: 3 },
      ],
    })).toEqual([
      expect.objectContaining({ id: 'assistant-1', content: 'first\n\nsecond', runId: 'run-1' }),
      expect.objectContaining({ id: 'tool-1', role: 'tool', tool_call_id: 'call-1', tool_name: 'inspect' }),
    ]);
  });

  it('flattens nested shortcut bindings to the Go map[string]string contract', () => {
    expect(serializeShortcutOptionsForWorkspace({
      runQuery: {
        mac: { combo: 'Meta+Enter', enabled: true },
        windows: { combo: 'Ctrl+Enter', enabled: false },
      },
    })).toEqual({
      'runQuery.mac.combo': 'Meta+Enter',
      'runQuery.mac.enabled': 'true',
      'runQuery.windows.combo': 'Ctrl+Enter',
      'runQuery.windows.enabled': 'false',
    });
  });

  it('clears settled local placeholders when the durable ledger returns an empty transcript', () => {
    expect(mergeAIChatSessionMessages([], [{
      id: 'local-error',
      role: 'assistant',
      content: 'Request failed',
      timestamp: 1,
      loading: false,
      excludeFromAIContext: true,
    }])).toEqual([]);
    expect(mergeAIChatSessionMessages([], [{
      id: 'local-loading',
      role: 'assistant',
      content: '',
      timestamp: 1,
      loading: true,
    }])).toEqual([expect.objectContaining({ id: 'local-loading' })]);
  });

  it('keeps a run-scoped terminal error when hydration races an empty Ledger transcript', () => {
    const terminalError = {
      id: 'agent-run-run-1-0-error',
      runId: 'run-1',
      role: 'assistant' as const,
      content: 'Error: stream payload failed',
      rawError: 'stream payload failed',
      timestamp: 2,
      loading: false,
      phase: 'idle' as const,
      excludeFromAIContext: true,
    };

    expect(mergeAIChatSessionMessages([], [terminalError])).toEqual([terminalError]);
  });

  it('keeps a terminal run failure visible after hydrating its durable tool turn', () => {
    const durable = [{
      id: 'durable-tool-turn',
      role: 'assistant' as const,
      content: '',
      tool_calls: [{
        id: 'call-connections',
        type: 'function' as const,
        function: { name: 'get_connections', arguments: '{}' },
      }],
      timestamp: 1,
      loading: false,
    }];
    const terminalError = {
      id: 'agent-run-run-1-0-error',
      runId: 'run-1',
      role: 'assistant' as const,
      content: 'Error: upstream model failed after tool execution',
      rawError: 'upstream model failed after tool execution',
      timestamp: 2,
      loading: false,
      phase: 'idle' as const,
      excludeFromAIContext: true,
    };

    expect(mergeAIChatSessionMessages(durable, [terminalError])).toEqual([
      durable[0],
      terminalError,
    ]);
  });

  it('does not resurrect a failed run pending row during hydration', () => {
    const pending = {
      id: 'agent-run-run-1-pending',
      runId: 'run-1',
      role: 'assistant' as const,
      content: '',
      timestamp: 3,
      loading: true,
      phase: 'queued' as const,
    };
    const terminalError = {
      id: 'agent-run-run-1-0-error',
      runId: 'run-1',
      role: 'assistant' as const,
      content: 'Error: reasoning effort is invalid',
      rawError: 'reasoning effort is invalid',
      timestamp: 2,
      loading: false,
      phase: 'idle' as const,
      excludeFromAIContext: true,
    };

    expect(mergeAIChatSessionMessages([], [pending, terminalError])).toEqual([
      terminalError,
    ]);
  });

  it('keeps terminal errors in chronological order relative to later user messages', () => {
    const userOne = {
      id: 'user-1',
      runId: 'run-1',
      role: 'user' as const,
      content: 'first question',
      timestamp: 1,
    };
    const error = {
      id: 'agent-run-run-1-0-error',
      runId: 'run-1',
      role: 'assistant' as const,
      content: 'Error: provider failed',
      rawError: 'provider failed',
      timestamp: 2,
      loading: false,
      phase: 'idle' as const,
      excludeFromAIContext: true,
    };
    const userTwo = {
      id: 'user-2',
      runId: 'run-2',
      role: 'user' as const,
      content: 'second question',
      timestamp: 3,
    };

    expect(mergeAIChatSessionMessages(
      [userOne, userTwo],
      [error],
    ).map((message) => message.id)).toEqual(['user-1', 'agent-run-run-1-0-error', 'user-2']);
  });
});
