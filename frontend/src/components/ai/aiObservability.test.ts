import { describe, expect, it } from 'vitest';

import {
  buildAIObservabilityDistribution,
  buildAIObservabilityEfficiency,
  buildAIObservabilityHeatmap,
  buildAIObservabilityLatencyPoints,
  buildAIObservabilityModelStats,
  buildAIObservabilityOutcomes,
  buildAIObservabilityTrend,
  filterAIRequestEvents,
  flattenAIRequestEvents,
  parseAIObservabilityTimestamp,
  summarizeAIRequestEvents,
} from './aiObservability';

const now = new Date(2026, 8, 9, 12, 30, 0, 0).getTime();

describe('AI observability projections', () => {
  it('normalizes encrypted-ledger run projections and timestamp units', () => {
    const result = flattenAIRequestEvents({
      total: 1,
      sessions: [{
        id: 'session-1',
        runs: [{
          runId: 'run-1', requestId: 'request-1', provider: 'grok', model: 'grok-3',
          createdAt: 1_757_395_800, updatedAt: 1_757_395_830, state: 'COMPLETED',
          promptTokens: 4, completionTokens: 6, totalTokens: 10, attempt: 2,
        }],
      }],
    });

    expect(parseAIObservabilityTimestamp(1_757_395_800)).toBe(1_757_395_800_000);
    expect(parseAIObservabilityTimestamp('2026-09-09T12:00:00Z')).toBeGreaterThan(0);
    expect(result).toEqual([expect.objectContaining({
      id: 'run-1', requestId: 'request-1', sessionId: 'session-1', providerId: 'grok',
      model: 'grok-3', state: 'completed', durationMs: 30_000,
      promptTokens: 4, completionTokens: 6, totalTokens: 10, attempt: 2,
    })]);
  });

  it('filters by local calendar range and dimensions', () => {
    const today = new Date(2026, 8, 9, 9, 0).getTime();
    const yesterday = new Date(2026, 8, 8, 23, 59).getTime();
    const records = [
      { id: 'today', createdAt: today, providerId: 'grok', model: 'grok-3', state: 'completed', taskKind: 'chat' },
      { id: 'yesterday', createdAt: yesterday, providerId: 'openai', model: 'gpt', state: 'failed', taskKind: 'chat' },
    ] as any[];

    expect(filterAIRequestEvents(records, { range: 'today' }, now).map((item) => item.id)).toEqual(['today']);
    expect(filterAIRequestEvents(records, { range: '7d', providerId: 'grok', model: 'grok-3', state: 'completed', taskKind: 'chat' }, now)).toHaveLength(1);
    expect(filterAIRequestEvents(records, { range: 'all', providerId: 'missing' }, now)).toEqual([]);
  });

  it('summarizes terminal success, usage and p95 duration', () => {
    const records = [10, 20, 30, 40].map((durationMs, index) => ({
      id: String(index), state: index === 3 ? 'failed' : 'completed', durationMs,
      promptTokens: index + 1, completionTokens: 2, totalTokens: index === 2 ? 0 : index + 3,
    })) as any[];
    const summary = summarizeAIRequestEvents(records);

    expect(summary).toMatchObject({
      requestCount: 4, completedCount: 3, failedCount: 1, successRate: 75,
      promptTokens: 10, completionTokens: 8, totalTokens: 13, usageReportedCount: 3,
      averageDurationMs: 25, p95DurationMs: 40,
    });
  });

  it('groups trend points by hour today and by day for longer ranges', () => {
    const records = [
      { id: 'a', createdAt: new Date(2026, 8, 9, 9, 5).getTime(), promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      { id: 'b', createdAt: new Date(2026, 8, 9, 9, 55).getTime(), promptTokens: 4, completionTokens: 1, totalTokens: 5 },
      { id: 'c', createdAt: new Date(2026, 8, 8, 9, 5).getTime(), promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ] as any[];

    expect(buildAIObservabilityTrend(records, 'today')).toEqual([
      expect.objectContaining({ requests: 1, promptTokens: 1, totalTokens: 2 }),
      expect.objectContaining({ requests: 2, promptTokens: 6, completionTokens: 4, totalTokens: 10 }),
    ]);
    expect(buildAIObservabilityTrend(records, '7d')).toHaveLength(2);
  });

  it('ranks models by reported tokens, then request count', () => {
    const records = [
      { providerId: 'grok', model: 'small', durationMs: 10, totalTokens: 2 },
      { providerId: 'grok', model: 'small', durationMs: 20, totalTokens: 3 },
      { providerId: 'openai', model: 'large', durationMs: 15, totalTokens: 10 },
    ] as any[];

    expect(buildAIObservabilityModelStats(records).map((item) => [item.model, item.requests, item.totalTokens, item.averageDurationMs])).toEqual([
      ['large', 1, 10, 15],
      ['small', 2, 5, 15],
    ]);
  });

  it('groups run outcomes without treating waiting or canceled runs as failures', () => {
    const records = [
      { state: 'completed' },
      { state: 'failed' },
      { state: 'exhausted' },
      { state: 'running_model' },
      { state: 'awaiting_approval' },
      { state: 'canceled' },
    ] as any[];

    expect(buildAIObservabilityOutcomes(records)).toEqual([
      { key: 'completed', count: 1, percentage: 100 / 6 },
      { key: 'failed', count: 2, percentage: 200 / 6 },
      { key: 'active', count: 2, percentage: 200 / 6 },
      { key: 'other', count: 1, percentage: 100 / 6 },
    ]);
  });

  it('builds model efficiency, latency points, and selectable usage distributions', () => {
    const records = [
      { id: 'a', providerId: 'grok', model: 'grok-3', taskKind: 'chat', state: 'completed', durationMs: 20, activeDurationMs: 15, promptTokens: 8, completionTokens: 2, totalTokens: 10 },
      { id: 'b', providerId: 'grok', model: 'grok-3', taskKind: 'chat', state: 'failed', durationMs: 40, activeDurationMs: 30, promptTokens: 18, completionTokens: 2, totalTokens: 20 },
      { id: 'c', providerId: 'openai', model: 'gpt', taskKind: 'query_editor_generation', state: 'completed', durationMs: 10, activeDurationMs: 0, promptTokens: 4, completionTokens: 1, totalTokens: 5 },
    ] as any[];

    expect(buildAIObservabilityEfficiency(records)[0]).toMatchObject({
      providerId: 'grok', model: 'grok-3', requests: 2, averageTokens: 15, averageDurationMs: 30,
    });
    expect(buildAIObservabilityLatencyPoints(records)).toEqual([
      expect.objectContaining({ id: 'a', activeDurationMs: 15, durationMs: 20 }),
      expect.objectContaining({ id: 'b', activeDurationMs: 30, durationMs: 40 }),
    ]);
    expect(buildAIObservabilityDistribution(records, 'providerId')).toEqual([
      expect.objectContaining({ key: 'grok', requests: 2, totalTokens: 30, percentage: 30 / 35 * 100 }),
      expect.objectContaining({ key: 'openai', requests: 1, totalTokens: 5, percentage: 5 / 35 * 100 }),
    ]);
    expect(buildAIObservabilityDistribution(records, 'taskKind').map((item) => item.key)).toEqual(['chat', 'query_editor_generation']);
  });

  it('builds a dense provider by model heatmap with explicit empty intersections', () => {
    const heatmap = buildAIObservabilityHeatmap([
      { providerId: 'grok', model: 'grok-3', totalTokens: 15 },
      { providerId: 'openai', model: 'gpt', totalTokens: 9 },
      { providerId: 'openai', model: 'gpt', totalTokens: 1 },
    ] as any[]);

    expect(heatmap.providers).toEqual(['grok', 'openai']);
    expect(heatmap.models).toEqual(['grok-3', 'gpt']);
    expect(heatmap.maxTokens).toBe(15);
    expect(heatmap.cells).toEqual(expect.arrayContaining([
      { key: 'grok\u0000gpt', providerId: 'grok', model: 'gpt', requests: 0, totalTokens: 0 },
      { key: 'openai\u0000gpt', providerId: 'openai', model: 'gpt', requests: 2, totalTokens: 10 },
    ]));
  });
});
