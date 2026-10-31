import { describe, expect, it } from 'vitest';

import { compareTargetObjectName, repairCompareTargetObjects } from './dataSyncCompareTargets';
import { createDataSyncTableMapping } from './model';

describe('data sync compare target fallback', () => {
  it('falls back to the source base name when the target name is empty', () => {
    const mapping = {
      ...createDataSyncTableMapping('m1'),
      sourceObject: 'sales.Orders',
    };

    expect(compareTargetObjectName(mapping)).toBe('Orders');
    expect(compareTargetObjectName({ ...mapping, targetObject: 'orders_archive' })).toBe(
      'orders_archive',
    );
  });

  it('repairs empty target names for compare tasks only', () => {
    const empty = {
      ...createDataSyncTableMapping('m1'),
      sourceObject: 'kf_ai_platform',
    };
    const filled = {
      ...createDataSyncTableMapping('m2'),
      sourceObject: 'orders',
      targetObject: 'orders_shadow',
    };

    const repaired = repairCompareTargetObjects('compare', [empty, filled]);
    expect(repaired[0].targetObject).toBe('kf_ai_platform');
    expect(repaired[1]).toBe(filled);

    expect(repairCompareTargetObjects('reconcile', [empty])[0].targetObject).toBe('');
    // 无改动时返回原数组引用，避免触发多余的任务 patch。
    expect(repairCompareTargetObjects('compare', [filled])[0]).toBe(filled);
  });
});
