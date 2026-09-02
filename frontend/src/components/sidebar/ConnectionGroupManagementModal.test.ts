import { describe, expect, it } from 'vitest';
import {
  findFirstRootTagToken,
  filterExistingConnectionIds,
  hasConnectionDragPayload,
} from './ConnectionGroupManagementModal';

describe('ConnectionGroupManagementModal helpers', () => {
  it('finds the first real root group after synthetic ungrouped content', () => {
    expect(findFirstRootTagToken([
      'connection:ungrouped-a',
      'tag:root-first',
      'connection:ungrouped-b',
      'tag:root-second',
    ])).toBe('tag:root-first');
    expect(findFirstRootTagToken(['connection:ungrouped-a'])).toBeNull();
  });

  it('recognizes only connection drags, keeping group tree drops isolated', () => {
    expect(hasConnectionDragPayload({ dataTransfer: { types: ['application/x-gonavi-connection-ids'] } } as any)).toBe(true);
    expect(hasConnectionDragPayload({ dataTransfer: { types: ['text/plain'] } } as any)).toBe(false);
  });

  it('removes deleted connections from a persisted cross-container selection', () => {
    expect(filterExistingConnectionIds(['conn-a', 'removed', 'conn-b'], [
      { id: 'conn-a' },
      { id: 'conn-b' },
    ])).toEqual(['conn-a', 'conn-b']);
  });
});
