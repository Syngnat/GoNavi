import { describe, expect, it } from 'vitest';

import { getTableMetadataIssueDetail, isTableMetadataIncomplete } from './tableMetadataResult';

describe('table metadata result helpers', () => {
  it('treats either partial or truncated metadata as incomplete', () => {
    expect(isTableMetadataIncomplete({ partial: true })).toBe(true);
    expect(isTableMetadataIncomplete({ truncated: true })).toBe(true);
    expect(isTableMetadataIncomplete({})).toBe(false);
  });

  it('uses the backend message before warning details', () => {
    expect(getTableMetadataIssueDetail({
      message: 'Redis key scan truncated',
      warnings: ['cursor loop detected'],
    })).toBe('Redis key scan truncated');
    expect(getTableMetadataIssueDetail({ warnings: ['cursor loop detected'] })).toBe('cursor loop detected');
  });
});
