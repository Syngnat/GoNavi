import type { SessionListResult, SessionProjectionResult } from './aiRunHarnessClient';

export type AIObservabilityRange = 'today' | '7d' | '30d' | 'all';

export interface AIRequestEventRecord {
  id: string;
  requestId: string;
  sessionId: string;
  providerId: string;
  model: string;
  thinking: string;
  taskKind: string;
  state: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  activeDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reservedTokens: number;
  terminalReason: string;
}

export interface AIObservabilityFilters {
  range: AIObservabilityRange;
  providerId?: string;
  model?: string;
  state?: string;
  taskKind?: string;
}

export interface AIObservabilitySummary {
  requestCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageReportedCount: number;
  averageDurationMs: number;
  averageActiveDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  latencySampleCount: number;
}

export interface AIObservabilityTrendPoint {
  key: string;
  timestamp: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AIObservabilityModelStat {
  key: string;
  providerId: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  completedCount: number;
  failedCount: number;
  averageTokens: number;
  averageDurationMs: number;
}

export type AIObservabilityOutcomeKey = 'completed' | 'failed' | 'active' | 'other';

export interface AIObservabilityOutcomeStat {
  key: AIObservabilityOutcomeKey;
  count: number;
  percentage: number;
}

export interface AIObservabilityEfficiencyPoint extends AIObservabilityModelStat {
  averageTokens: number;
}

export interface AIObservabilityLatencyPoint {
  id: string;
  providerId: string;
  model: string;
  activeDurationMs: number;
  durationMs: number;
  totalTokens: number;
}

export type AIObservabilityDistributionDimension = 'providerId' | 'model' | 'taskKind' | 'state';

export interface AIObservabilityDistributionStat {
  key: string;
  requests: number;
  totalTokens: number;
  percentage: number;
}

export interface AIObservabilityHeatmapCell {
  key: string;
  providerId: string;
  model: string;
  requests: number;
  totalTokens: number;
}

export interface AIObservabilityHeatmap {
  providers: string[];
  models: string[];
  cells: AIObservabilityHeatmapCell[];
  maxTokens: number;
  maxRequests: number;
}

const finiteNumber = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

export const parseAIObservabilityTimestamp = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeRun = (
  raw: Record<string, unknown>,
  session: SessionProjectionResult,
): AIRequestEventRecord | null => {
  const id = String(raw.runId || raw.id || '').trim();
  if (!id) return null;
  const createdAt = parseAIObservabilityTimestamp(raw.createdAt);
  const updatedAt = parseAIObservabilityTimestamp(raw.updatedAt);
  const activeDurationMs = finiteNumber(raw.activeDurationMs ?? raw.activeDurationMS);
  const elapsedDurationMs = createdAt > 0 && updatedAt >= createdAt ? updatedAt - createdAt : 0;
  return {
    id,
    requestId: String(raw.requestId || '').trim(),
    sessionId: String(raw.sessionId || session.sessionId || session.id || '').trim(),
    providerId: String(raw.provider || '').trim(),
    model: String(raw.model || '').trim(),
    thinking: String(raw.thinking || '').trim(),
    taskKind: String(raw.taskKind || 'chat').trim() || 'chat',
    state: String(raw.state || 'queued').trim().toLowerCase() || 'queued',
    attempt: Math.max(0, Math.trunc(finiteNumber(raw.attempt))),
    createdAt,
    updatedAt,
    durationMs: elapsedDurationMs || activeDurationMs,
    activeDurationMs,
    promptTokens: Math.trunc(finiteNumber(raw.promptTokens)),
    completionTokens: Math.trunc(finiteNumber(raw.completionTokens)),
    totalTokens: Math.trunc(finiteNumber(raw.totalTokens)),
    reservedTokens: Math.trunc(finiteNumber(raw.reservedTokens)),
    terminalReason: String(raw.terminalReason || '').trim(),
  };
};

export const flattenAIRequestEvents = (
  result: SessionListResult | undefined,
): AIRequestEventRecord[] => {
  const records: AIRequestEventRecord[] = [];
  for (const session of Array.isArray(result?.sessions) ? result.sessions : []) {
    for (const raw of Array.isArray(session.runs) ? session.runs : []) {
      const record = normalizeRun(raw, session);
      if (record) records.push(record);
    }
  }
  return records.sort((left, right) => right.createdAt - left.createdAt || right.updatedAt - left.updatedAt);
};

export const resolveAIObservabilityRangeStart = (
  range: AIObservabilityRange,
  now = Date.now(),
): number => {
  if (range === 'all') return 0;
  const current = new Date(now);
  if (range === 'today') {
    current.setHours(0, 0, 0, 0);
    return current.getTime();
  }
  current.setHours(0, 0, 0, 0);
  current.setDate(current.getDate() - (range === '7d' ? 6 : 29));
  return current.getTime();
};

export const filterAIRequestEvents = (
  records: AIRequestEventRecord[],
  filters: AIObservabilityFilters,
  now = Date.now(),
): AIRequestEventRecord[] => {
  const rangeStart = resolveAIObservabilityRangeStart(filters.range, now);
  return records.filter((record) => (
    (rangeStart === 0 || record.createdAt >= rangeStart)
    && (!filters.providerId || record.providerId === filters.providerId)
    && (!filters.model || record.model === filters.model)
    && (!filters.state || record.state === filters.state)
    && (!filters.taskKind || record.taskKind === filters.taskKind)
  ));
};

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
};

export const summarizeAIRequestEvents = (
  records: AIRequestEventRecord[],
): AIObservabilitySummary => {
  const completedCount = records.filter((record) => record.state === 'completed').length;
  const failedCount = records.filter((record) => ['failed', 'exhausted', 'recovery_required'].includes(record.state)).length;
  const terminalRecords = records.filter((record) => ['completed', 'failed', 'canceled', 'exhausted', 'interrupted', 'recovery_required'].includes(record.state));
  const durations = terminalRecords.map((record) => record.durationMs).filter((duration) => duration > 0);
  const activeDurations = terminalRecords.map((record) => record.activeDurationMs).filter((duration) => duration > 0);
  const promptTokens = records.reduce((sum, record) => sum + record.promptTokens, 0);
  const completionTokens = records.reduce((sum, record) => sum + record.completionTokens, 0);
  const totalTokens = records.reduce((sum, record) => sum + record.totalTokens, 0);
  return {
    requestCount: records.length,
    completedCount,
    failedCount,
    successRate: terminalRecords.length > 0 ? (completedCount / terminalRecords.length) * 100 : 0,
    promptTokens,
    completionTokens,
    totalTokens,
    usageReportedCount: records.filter((record) => record.totalTokens > 0).length,
    averageDurationMs: durations.length > 0
      ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
      : 0,
    averageActiveDurationMs: activeDurations.length > 0
      ? activeDurations.reduce((sum, duration) => sum + duration, 0) / activeDurations.length
      : 0,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    latencySampleCount: durations.length,
  };
};

const startOfHour = (timestamp: number): number => {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.getTime();
};

const startOfDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export const buildAIObservabilityTrend = (
  records: AIRequestEventRecord[],
  range: AIObservabilityRange,
): AIObservabilityTrendPoint[] => {
  const hourly = range === 'today';
  const buckets = new Map<number, AIObservabilityTrendPoint>();
  for (const record of records) {
    if (record.createdAt <= 0) continue;
    const timestamp = hourly ? startOfHour(record.createdAt) : startOfDay(record.createdAt);
    const current = buckets.get(timestamp) || {
      key: String(timestamp),
      timestamp,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    current.requests += 1;
    current.promptTokens += record.promptTokens;
    current.completionTokens += record.completionTokens;
    current.totalTokens += record.totalTokens;
    buckets.set(timestamp, current);
  }
  return [...buckets.values()].sort((left, right) => left.timestamp - right.timestamp);
};

export const buildAIObservabilityModelStats = (
  records: AIRequestEventRecord[],
): AIObservabilityModelStat[] => {
  const groups = new Map<string, {
    providerId: string;
    model: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    completedCount: number;
    failedCount: number;
    totalDurationMs: number;
  }>();
  for (const record of records) {
    const model = record.model || '—';
    const key = `${record.providerId}\u0000${model}`;
    const current = groups.get(key) || {
      providerId: record.providerId,
      model,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      completedCount: 0,
      failedCount: 0,
      totalDurationMs: 0,
    };
    current.requests += 1;
    current.promptTokens += record.promptTokens;
    current.completionTokens += record.completionTokens;
    current.totalTokens += record.totalTokens;
    current.completedCount += record.state === 'completed' ? 1 : 0;
    current.failedCount += ['failed', 'exhausted', 'recovery_required'].includes(record.state) ? 1 : 0;
    current.totalDurationMs += record.durationMs;
    groups.set(key, current);
  }
  return [...groups.entries()].map(([key, value]) => ({
    key,
    providerId: value.providerId,
    model: value.model,
    requests: value.requests,
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    totalTokens: value.totalTokens,
    completedCount: value.completedCount,
    failedCount: value.failedCount,
    averageTokens: value.requests > 0 ? value.totalTokens / value.requests : 0,
    averageDurationMs: value.requests > 0 ? value.totalDurationMs / value.requests : 0,
  })).sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests || left.model.localeCompare(right.model));
};

const failedStates = new Set(['failed', 'exhausted', 'recovery_required']);
const activeStates = new Set(['queued', 'running_model', 'running_tool', 'awaiting_approval', 'awaiting_workspace', 'canceling']);

export const buildAIObservabilityOutcomes = (
  records: AIRequestEventRecord[],
): AIObservabilityOutcomeStat[] => {
  const counts: Record<AIObservabilityOutcomeKey, number> = { completed: 0, failed: 0, active: 0, other: 0 };
  for (const record of records) {
    if (record.state === 'completed') counts.completed += 1;
    else if (failedStates.has(record.state)) counts.failed += 1;
    else if (activeStates.has(record.state)) counts.active += 1;
    else counts.other += 1;
  }
  return (Object.keys(counts) as AIObservabilityOutcomeKey[]).map((key) => ({
    key,
    count: counts[key],
    percentage: records.length > 0 ? (counts[key] * 100) / records.length : 0,
  }));
};

export const buildAIObservabilityEfficiency = (
  records: AIRequestEventRecord[],
): AIObservabilityEfficiencyPoint[] => buildAIObservabilityModelStats(records)
  .filter((item) => item.averageDurationMs > 0 || item.averageTokens > 0);

export const buildAIObservabilityLatencyPoints = (
  records: AIRequestEventRecord[],
): AIObservabilityLatencyPoint[] => records
  .filter((record) => record.activeDurationMs > 0 && record.durationMs > 0)
  .map((record) => ({
    id: record.id,
    providerId: record.providerId,
    model: record.model || '—',
    activeDurationMs: record.activeDurationMs,
    durationMs: record.durationMs,
    totalTokens: record.totalTokens,
  }));

export const buildAIObservabilityDistribution = (
  records: AIRequestEventRecord[],
  dimension: AIObservabilityDistributionDimension,
): AIObservabilityDistributionStat[] => {
  const groups = new Map<string, { requests: number; totalTokens: number }>();
  for (const record of records) {
    const key = String(record[dimension] || '—');
    const current = groups.get(key) || { requests: 0, totalTokens: 0 };
    current.requests += 1;
    current.totalTokens += record.totalTokens;
    groups.set(key, current);
  }
  const reportedTokens = [...groups.values()].reduce((sum, item) => sum + item.totalTokens, 0);
  const totalValue = reportedTokens > 0 ? reportedTokens : records.length;
  return [...groups.entries()].map(([key, value]) => ({
    key,
    requests: value.requests,
    totalTokens: value.totalTokens,
    percentage: totalValue > 0
      ? ((reportedTokens > 0 ? value.totalTokens : value.requests) / totalValue) * 100
      : 0,
  })).sort((left, right) => (
    reportedTokens > 0
      ? right.totalTokens - left.totalTokens || right.requests - left.requests
      : right.requests - left.requests
  ) || left.key.localeCompare(right.key));
};

export const buildAIObservabilityHeatmap = (
  records: AIRequestEventRecord[],
): AIObservabilityHeatmap => {
  const providerTotals = new Map<string, number>();
  const modelTotals = new Map<string, number>();
  const populated = new Map<string, AIObservabilityHeatmapCell>();
  for (const record of records) {
    const providerId = record.providerId || '—';
    const model = record.model || '—';
    const key = `${providerId}\u0000${model}`;
    const current = populated.get(key) || { key, providerId, model, requests: 0, totalTokens: 0 };
    current.requests += 1;
    current.totalTokens += record.totalTokens;
    populated.set(key, current);
    providerTotals.set(providerId, (providerTotals.get(providerId) || 0) + record.totalTokens);
    modelTotals.set(model, (modelTotals.get(model) || 0) + record.totalTokens);
  }
  const byTotal = (totals: Map<string, number>) => [...totals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key]) => key);
  const providers = byTotal(providerTotals);
  const models = byTotal(modelTotals);
  const cells = providers.flatMap((providerId) => models.map((model) => {
    const key = `${providerId}\u0000${model}`;
    return populated.get(key) || { key, providerId, model, requests: 0, totalTokens: 0 };
  }));
  return {
    providers,
    models,
    cells,
    maxTokens: Math.max(0, ...cells.map((cell) => cell.totalTokens)),
    maxRequests: Math.max(0, ...cells.map((cell) => cell.requests)),
  };
};

export const uniqueAIObservabilityValues = (
  records: AIRequestEventRecord[],
  key: 'providerId' | 'model' | 'state' | 'taskKind',
): string[] => [...new Set(records.map((record) => record[key]).filter(Boolean))].sort((left, right) => left.localeCompare(right));
