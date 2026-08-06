import { describe, expect, it } from 'vitest';

import {
  buildTDengineStableOptions,
  buildTDengineStableQueries,
} from './tdengineStableMetadata';

describe('TDengine stable metadata helpers', () => {
  it('reads stable_name returned by SHOW STABLES and removes duplicate names', () => {
    expect(buildTDengineStableOptions([
      { stable_name: 'meters' },
      { STABLE_NAME: 'meters' },
      { name: 'weather' },
      { stable_name: '' },
      { comment: 'not a stable name' },
    ])).toEqual([
      { label: 'meters', value: 'meters' },
      { label: 'weather', value: 'weather' },
    ]);
  });

  it('keeps TDengine query fallbacks for context and qualified database syntax', () => {
    expect(buildTDengineStableQueries('metrics')).toEqual([
      'SHOW STABLES',
      'SHOW STABLES FROM `metrics`',
      'SHOW STABLES FROM metrics',
      'SHOW metrics.STABLES',
    ]);
    expect(buildTDengineStableQueries('metrics`prod')).toContain('SHOW STABLES FROM `metrics``prod`');
    expect(buildTDengineStableQueries('')).toEqual(['SHOW STABLES']);
  });
});
