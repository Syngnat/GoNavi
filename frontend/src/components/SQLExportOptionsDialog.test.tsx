import { describe, expect, it } from 'vitest';

import { normalizeSQLExportOptions } from './SQLExportOptionsDialog';

describe('SQLExportOptionsDialog', () => {
  it('keeps DROP IF EXISTS disabled unless the user explicitly enables it', () => {
    expect(normalizeSQLExportOptions()).toEqual({ includeDropIfExists: false });
    expect(normalizeSQLExportOptions({ includeDropIfExists: false })).toEqual({ includeDropIfExists: false });
    expect(normalizeSQLExportOptions({ includeDropIfExists: true })).toEqual({ includeDropIfExists: true });
  });
});
