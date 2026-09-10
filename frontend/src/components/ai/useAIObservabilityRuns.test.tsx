import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAIObservabilityRuns, type AIObservabilityRunsState } from './useAIObservabilityRuns';

const session = (id: string, runId: string) => ({
  id,
  runs: [{ runId, provider: 'grok', model: 'grok-3', state: 'completed', createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:01Z', totalTokens: 3 }],
});

describe('useAIObservabilityRuns', () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it('does not load while inactive, then loads and appends the next session page', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ total: 2, sessions: [session('s1', 'r1')] })
      .mockResolvedValueOnce({ total: 2, sessions: [session('s2', 'r2')] });
    vi.stubGlobal('window', { go: { aiservice: { Service: { AIListAgentSessions: list } } } });
    let latest!: AIObservabilityRunsState;
    const Probe = ({ active }: { active: boolean }) => {
      latest = useAIObservabilityRuns(active);
      return null;
    };

    await act(async () => {
      renderer = create(<Probe active={false} />);
    });
    expect(list).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.update(<Probe active />);
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(latest.records.map((record) => record.id)).toEqual(['r1']);
    expect(latest.hasMore).toBe(true);

    await act(async () => {
      await latest.loadMore();
    });
    expect(list).toHaveBeenLastCalledWith({ limit: 100, offset: 1 });
    expect(latest.records.map((record) => record.id)).toEqual(['r1', 'r2']);
    expect(latest.loadedSessionCount).toBe(2);
    expect(latest.hasMore).toBe(false);
  });

  it('reports an unavailable bridge without throwing', async () => {
    vi.stubGlobal('window', { go: { aiservice: { Service: {} } } });
    let latest!: AIObservabilityRunsState;
    const Probe = () => {
      latest = useAIObservabilityRuns(true);
      return null;
    };

    await act(async () => {
      renderer = create(<Probe />);
      await Promise.resolve();
    });
    expect(latest.error).toBe('service_unavailable');
    expect(latest.records).toEqual([]);
  });
});
