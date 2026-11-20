import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUERY_RESULT_TAB_RETENTION,
  isQueryResultTabProtected,
  sanitizeQueryResultTabRetention,
  shouldReplaceQueryResultTabs,
} from './queryResultTabRetention';

describe('query result tab retention', () => {
  it('defaults missing or invalid values to latest', () => {
    expect(DEFAULT_QUERY_RESULT_TAB_RETENTION).toBe('latest');
    expect(sanitizeQueryResultTabRetention(undefined)).toBe('latest');
    expect(sanitizeQueryResultTabRetention('unknown')).toBe('latest');
    expect(sanitizeQueryResultTabRetention('history')).toBe('history');
    expect(sanitizeQueryResultTabRetention('latest')).toBe('latest');
  });

  it('resolves whether the previous result group should be replaced', () => {
    expect(shouldReplaceQueryResultTabs('history')).toBe(false);
    expect(shouldReplaceQueryResultTabs('latest')).toBe(true);
    expect(shouldReplaceQueryResultTabs(undefined)).toBe(true);
  });

  it('protects pinned and unsaved result tabs', () => {
    expect(isQueryResultTabProtected({ pinned: true })).toBe(true);
    expect(isQueryResultTabProtected({ hasPendingChanges: true })).toBe(true);
    expect(isQueryResultTabProtected({ pinned: false, hasPendingChanges: false })).toBe(false);
    expect(isQueryResultTabProtected({})).toBe(false);
  });
});
