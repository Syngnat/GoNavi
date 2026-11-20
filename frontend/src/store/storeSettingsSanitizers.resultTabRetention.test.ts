import { describe, expect, it } from 'vitest';

import { sanitizeQueryOptions } from './storeSettingsSanitizers';

describe('sanitizeQueryOptions result tab retention', () => {
  it('fills the default for persisted states created before the setting existed', () => {
    expect(sanitizeQueryOptions({}).resultTabRetention).toBe('latest');
  });

  it('keeps an explicit history preference', () => {
    expect(sanitizeQueryOptions({ resultTabRetention: 'history' }).resultTabRetention)
      .toBe('history');
  });

  it('falls back to latest for invalid persisted values', () => {
    expect(sanitizeQueryOptions({ resultTabRetention: 'forever' }).resultTabRetention)
      .toBe('latest');
  });
});
