import type { AIRunDispatchMode } from './aiRunHarnessClient';

export interface AIRunPolicy {
  defaultDispatchMode: AIRunDispatchMode;
  softToolRoundLimit: number;
  maxToolRounds: number;
  maxConsecutiveFailedToolRounds: number;
  maxToolNudges: number;
  maxModelRetriesPerTurn: number;
  maxActiveDuration: number;
  modelTurnTimeout: number;
  modelIdleTimeout: number;
  defaultToolTimeout: number;
  maxTotalTokens: number;
  maxToolResultBytes: number;
}

/**
 * Process-coordination settings shared by the desktop and CLI adapters.
 * These values are deliberately outside a run's frozen budget policy: they
 * control how clients communicate with the persisted Harness while a run is
 * alive.
 */
export interface AIRunRuntimeConfig {
  controlPollInterval: number;
  workspaceSnapshotRenewInterval: number;
  workspaceSnapshotLeaseDuration: number;
  /** How often the desktop adapter reloads the shared policy file. */
  policyWatchInterval: number;
}

export interface AIRunPolicySnapshot {
  schemaVersion: number;
  revision: number;
  policy: AIRunPolicy;
  runtime: AIRunRuntimeConfig;
}

export const NANOSECONDS_PER_SECOND = 1_000_000_000;
export const NANOSECONDS_PER_MILLISECOND = 1_000_000;
export const BYTES_PER_KIB = 1024;

export const DEFAULT_AI_RUN_POLICY: AIRunPolicy = {
  defaultDispatchMode: 'queue',
  softToolRoundLimit: 10,
  maxToolRounds: 15,
  maxConsecutiveFailedToolRounds: 3,
  maxToolNudges: 2,
  maxModelRetriesPerTurn: 1,
  maxActiveDuration: 30 * 60 * NANOSECONDS_PER_SECOND,
  modelTurnTimeout: 0,
  modelIdleTimeout: 0,
  defaultToolTimeout: 0,
  maxTotalTokens: 0,
  maxToolResultBytes: 1024 * 1024,
};

export const DEFAULT_AI_RUN_RUNTIME_CONFIG: AIRunRuntimeConfig = {
  controlPollInterval: 200_000_000,
  workspaceSnapshotRenewInterval: 5 * NANOSECONDS_PER_SECOND,
  workspaceSnapshotLeaseDuration: 15 * NANOSECONDS_PER_SECOND,
  policyWatchInterval: 500 * NANOSECONDS_PER_MILLISECOND,
};

const positiveInteger = (value: unknown, fallback: number, minimum = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.floor(parsed);
};

const durationNanoseconds = (value: unknown, fallback: number): number => {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i);
    if (match) {
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      const multiplier = unit === 'ms'
        ? NANOSECONDS_PER_SECOND / 1000
        : unit === 'm'
          ? NANOSECONDS_PER_SECOND * 60
          : unit === 'h'
            ? NANOSECONDS_PER_SECOND * 60 * 60
            : NANOSECONDS_PER_SECOND;
      return Math.round(amount * multiplier);
    }
  }
  return positiveInteger(value, fallback);
};

const requiredDurationNanoseconds = (value: unknown): number | undefined => {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i);
    if (!match) return undefined;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'ms'
      ? NANOSECONDS_PER_MILLISECOND
      : unit === 'm'
        ? NANOSECONDS_PER_SECOND * 60
        : unit === 'h'
          ? NANOSECONDS_PER_SECOND * 60 * 60
          : NANOSECONDS_PER_SECOND;
    const duration = Math.round(amount * multiplier);
    return Number.isSafeInteger(duration) && duration > 0 ? duration : undefined;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
};

export const isValidAIRunRuntimeConfig = (value: Partial<AIRunRuntimeConfig> | null | undefined): value is AIRunRuntimeConfig => {
  if (!value) return false;
  const controlPollInterval = value.controlPollInterval;
  const workspaceSnapshotRenewInterval = value.workspaceSnapshotRenewInterval;
  const workspaceSnapshotLeaseDuration = value.workspaceSnapshotLeaseDuration;
  const policyWatchInterval = value.policyWatchInterval;
  return typeof controlPollInterval === 'number'
    && Number.isSafeInteger(controlPollInterval)
    && controlPollInterval > 0
    && typeof workspaceSnapshotRenewInterval === 'number'
    && Number.isSafeInteger(workspaceSnapshotRenewInterval)
    && workspaceSnapshotRenewInterval > 0
    && typeof workspaceSnapshotLeaseDuration === 'number'
    && Number.isSafeInteger(workspaceSnapshotLeaseDuration)
    && workspaceSnapshotLeaseDuration > 0
    && typeof policyWatchInterval === 'number'
    && Number.isSafeInteger(policyWatchInterval)
    && policyWatchInterval > 0
    && workspaceSnapshotRenewInterval < workspaceSnapshotLeaseDuration;
};

/**
 * A source that renews at or after its lease expiry will intermittently look
 * offline. Treat the whole runtime tuple as invalid instead of mixing a
 * caller-provided cadence with fallback fields.
 */
export const normalizeAIRunRuntimeConfig = (
  value: Record<string, unknown> | undefined | null,
): AIRunRuntimeConfig => {
  const source = value || {};
  const runtime: Partial<AIRunRuntimeConfig> = {
    controlPollInterval: requiredDurationNanoseconds(source.controlPollInterval),
    workspaceSnapshotRenewInterval: requiredDurationNanoseconds(source.workspaceSnapshotRenewInterval),
    workspaceSnapshotLeaseDuration: requiredDurationNanoseconds(source.workspaceSnapshotLeaseDuration),
    policyWatchInterval: requiredDurationNanoseconds(source.policyWatchInterval),
  };
  if (!isValidAIRunRuntimeConfig(runtime)) {
    return { ...DEFAULT_AI_RUN_RUNTIME_CONFIG };
  }
  return runtime;
};

export const normalizeAIRunPolicy = (value: Record<string, unknown> | undefined | null): AIRunPolicy => {
  const source = value || {};
  return {
    defaultDispatchMode: source.defaultDispatchMode === 'steer' ? 'steer' : 'queue',
    softToolRoundLimit: positiveInteger(source.softToolRoundLimit, DEFAULT_AI_RUN_POLICY.softToolRoundLimit, 1),
    maxToolRounds: positiveInteger(source.maxToolRounds, DEFAULT_AI_RUN_POLICY.maxToolRounds, 1),
    maxConsecutiveFailedToolRounds: positiveInteger(source.maxConsecutiveFailedToolRounds, DEFAULT_AI_RUN_POLICY.maxConsecutiveFailedToolRounds, 1),
    maxToolNudges: positiveInteger(source.maxToolNudges, DEFAULT_AI_RUN_POLICY.maxToolNudges, 0),
    maxModelRetriesPerTurn: positiveInteger(source.maxModelRetriesPerTurn, DEFAULT_AI_RUN_POLICY.maxModelRetriesPerTurn, 0),
    maxActiveDuration: durationNanoseconds(source.maxActiveDuration, DEFAULT_AI_RUN_POLICY.maxActiveDuration),
    modelTurnTimeout: durationNanoseconds(source.modelTurnTimeout, DEFAULT_AI_RUN_POLICY.modelTurnTimeout),
    modelIdleTimeout: durationNanoseconds(source.modelIdleTimeout, DEFAULT_AI_RUN_POLICY.modelIdleTimeout),
    defaultToolTimeout: durationNanoseconds(source.defaultToolTimeout, DEFAULT_AI_RUN_POLICY.defaultToolTimeout),
    maxTotalTokens: positiveInteger(source.maxTotalTokens, DEFAULT_AI_RUN_POLICY.maxTotalTokens, 0),
    maxToolResultBytes: positiveInteger(source.maxToolResultBytes, DEFAULT_AI_RUN_POLICY.maxToolResultBytes, 1),
  };
};

export const normalizeAIRunPolicySnapshot = (
  value: unknown,
): AIRunPolicySnapshot => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawPolicy = source.policy;
  const rawRuntime = source.runtime;
  const policy = rawPolicy && typeof rawPolicy === 'object' && !Array.isArray(rawPolicy)
    ? rawPolicy as Record<string, unknown>
    : {};
  const runtime = rawRuntime && typeof rawRuntime === 'object' && !Array.isArray(rawRuntime)
    ? rawRuntime as Record<string, unknown>
    : {};
  const revision = Number(source.revision);
  const schemaVersion = Number(source.schemaVersion);
  return {
    schemaVersion: Number.isSafeInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 0,
    policy: normalizeAIRunPolicy(policy),
    runtime: normalizeAIRunRuntimeConfig(runtime),
  };
};

export const durationSeconds = (nanoseconds: number): number => Math.round(nanoseconds / NANOSECONDS_PER_SECOND);

export const durationMinutes = (nanoseconds: number): number => Math.round(nanoseconds / (NANOSECONDS_PER_SECOND * 60));
