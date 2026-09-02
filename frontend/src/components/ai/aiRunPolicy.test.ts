import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AI_RUN_RUNTIME_CONFIG,
  DEFAULT_AI_RUN_POLICY,
  NANOSECONDS_PER_MILLISECOND,
  NANOSECONDS_PER_SECOND,
  normalizeAIRunPolicySnapshot,
  normalizeAIRunPolicy,
} from './aiRunPolicy';

describe('AI run policy projection', () => {
  it('keeps Go duration values in nanoseconds', () => {
    expect(normalizeAIRunPolicy({
      maxActiveDuration: 90 * NANOSECONDS_PER_SECOND,
      modelTurnTimeout: 5 * NANOSECONDS_PER_SECOND,
      modelIdleTimeout: 0,
      defaultToolTimeout: 60 * NANOSECONDS_PER_SECOND,
    })).toMatchObject({
      maxActiveDuration: 90 * NANOSECONDS_PER_SECOND,
      modelTurnTimeout: 5 * NANOSECONDS_PER_SECOND,
      modelIdleTimeout: 0,
      defaultToolTimeout: 60 * NANOSECONDS_PER_SECOND,
    });
  });

  it('accepts the duration strings returned by the browser mock', () => {
    expect(normalizeAIRunPolicy({
      maxActiveDuration: '30m',
      modelTurnTimeout: '0s',
      modelIdleTimeout: '500ms',
      defaultToolTimeout: '1.5h',
    })).toMatchObject({
      maxActiveDuration: 30 * 60 * NANOSECONDS_PER_SECOND,
      modelTurnTimeout: 0,
      modelIdleTimeout: NANOSECONDS_PER_SECOND / 2,
      defaultToolTimeout: 90 * 60 * NANOSECONDS_PER_SECOND,
    });
  });

  it('preserves zero-valued optional limits rather than substituting defaults', () => {
    const policy = normalizeAIRunPolicy({
      modelTurnTimeout: 0,
      modelIdleTimeout: 0,
      defaultToolTimeout: 0,
      maxTotalTokens: 0,
    });

    expect(policy).toMatchObject({
      modelTurnTimeout: 0,
      modelIdleTimeout: 0,
      defaultToolTimeout: 0,
      maxTotalTokens: 0,
    });
    expect(policy.maxActiveDuration).toBe(DEFAULT_AI_RUN_POLICY.maxActiveDuration);
  });

  it('normalizes runtime durations from Wails nanoseconds and human-readable strings', () => {
    expect(normalizeAIRunPolicySnapshot({
      schemaVersion: 1,
      revision: 4,
      policy: {},
      runtime: {
      controlPollInterval: 250 * NANOSECONDS_PER_MILLISECOND,
      workspaceSnapshotRenewInterval: '2.5s',
      workspaceSnapshotLeaseDuration: '10s',
      policyWatchInterval: '750ms',
    },
  }).runtime).toEqual({
    controlPollInterval: 250 * NANOSECONDS_PER_MILLISECOND,
    workspaceSnapshotRenewInterval: 2_500 * NANOSECONDS_PER_MILLISECOND,
    workspaceSnapshotLeaseDuration: 10 * NANOSECONDS_PER_SECOND,
    policyWatchInterval: 750 * NANOSECONDS_PER_MILLISECOND,
  });
  });

  it('falls back to the complete runtime default when a tuple is incomplete or unsafe', () => {
    expect(normalizeAIRunPolicySnapshot({
      schemaVersion: 1,
      revision: 4,
      policy: {},
      runtime: {
        controlPollInterval: 100 * NANOSECONDS_PER_MILLISECOND,
        workspaceSnapshotRenewInterval: 15 * NANOSECONDS_PER_SECOND,
        workspaceSnapshotLeaseDuration: 15 * NANOSECONDS_PER_SECOND,
        policyWatchInterval: 500 * NANOSECONDS_PER_MILLISECOND,
      },
    }).runtime).toEqual(DEFAULT_AI_RUN_RUNTIME_CONFIG);

    expect(normalizeAIRunPolicySnapshot({
      schemaVersion: 1,
      revision: 4,
      policy: {},
      runtime: { workspaceSnapshotRenewInterval: 'not-a-duration' },
    }).runtime).toEqual(DEFAULT_AI_RUN_RUNTIME_CONFIG);
  });
});
