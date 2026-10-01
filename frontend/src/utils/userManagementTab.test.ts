import { describe, expect, it } from 'vitest';
import { buildUserManagementWorkbenchTab, USER_MANAGEMENT_PICKER_TAB_ID } from './userManagementTab';

describe('buildUserManagementWorkbenchTab', () => {
  it('builds one tab per connection so reopening activates the existing tab', () => {
    const first = buildUserManagementWorkbenchTab('conn-1');
    expect(first).toMatchObject({ id: 'user-management:conn-1', type: 'user-management', connectionId: 'conn-1' });
    expect(buildUserManagementWorkbenchTab(' conn-1 ').id).toBe(first.id);
  });

  it('falls back to the connection picker tab when no connection is given', () => {
    expect(buildUserManagementWorkbenchTab('')).toMatchObject({ id: USER_MANAGEMENT_PICKER_TAB_ID, connectionId: '' });
  });
});
