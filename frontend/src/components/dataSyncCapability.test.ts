import { describe, expect, it } from 'vitest';

import {
  resolveDataSyncCapabilityPresentation,
  type DataSyncCapabilitySnapshot,
} from './dataSyncCapability';

const tr = (key: string, vars?: Record<string, unknown>) =>
  `${key}:${String(vars?.sourceType || '')}->${String(vars?.targetType || '')}`;

const capability = (
  overrides: Partial<DataSyncCapabilitySnapshot> = {},
): DataSyncCapabilitySnapshot => ({
  sourceType: 'mysql',
  targetType: 'postgres',
  planner: 'mysql-pglike-planner',
  supportLevel: 'full',
  canExecute: true,
  supportsAutoCreate: true,
  supportsAutoAddColumns: true,
  requiresExistingTarget: false,
  ...overrides,
});

describe('resolveDataSyncCapabilityPresentation', () => {
  it('presents a full planner without the obsolete MySQL-to-Kingbase-only claim', () => {
    const result = resolveDataSyncCapabilityPresentation(capability(), tr);

    expect(result.alertType).toBe('info');
    expect(result.message).toBe(
      'data_sync.capability.full:mysql->postgres',
    );
    expect(result.blocksExecution).toBe(false);
    expect(result.forceExistingTarget).toBe(false);
  });

  it('makes legacy compatibility mode require an existing target', () => {
    const result = resolveDataSyncCapabilityPresentation(
      capability({
        sourceType: 'oracle',
        targetType: 'sqlserver',
        planner: 'generic-legacy-planner',
        supportLevel: 'partial',
        supportsAutoCreate: false,
        supportsAutoAddColumns: false,
        requiresExistingTarget: true,
      }),
      tr,
    );

    expect(result.alertType).toBe('warning');
    expect(result.message).toBe(
      'data_sync.capability.partial:oracle->sqlserver',
    );
    expect(result.blocksExecution).toBe(false);
    expect(result.forceExistingTarget).toBe(true);
  });

  it.each(['planned', 'unsupported'] as const)(
    'blocks %s migration pairs before execution',
    (supportLevel) => {
      const result = resolveDataSyncCapabilityPresentation(
        capability({
          supportLevel,
          canExecute: false,
          supportsAutoCreate: false,
          requiresExistingTarget: true,
        }),
        tr,
      );

      expect(result.alertType).toBe('error');
      expect(result.message).toBe(
        `data_sync.capability.${supportLevel}:mysql->postgres`,
      );
      expect(result.blocksExecution).toBe(true);
      expect(result.forceExistingTarget).toBe(true);
    },
  );
});
