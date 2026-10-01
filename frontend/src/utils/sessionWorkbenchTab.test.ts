import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentLanguage, t } from '../i18n';
import {
  buildSessionWorkbenchTab,
  SESSION_WORKBENCH_TAB_ID,
} from './sessionWorkbenchTab';

describe('sessionWorkbenchTab', () => {
  afterEach(() => setCurrentLanguage('zh-CN'));

  it('uses one stable tab for every entry point and trims scope values', () => {
    expect(buildSessionWorkbenchTab({
      connectionId: ' conn-1 ',
      dbName: ' analytics ',
    })).toEqual({
      id: SESSION_WORKBENCH_TAB_ID,
      title: t('session_workbench.title'),
      type: 'session-workbench',
      connectionId: 'conn-1',
      dbName: 'analytics',
    });
    expect(buildSessionWorkbenchTab({ connectionId: 'conn-2' }).id)
      .toBe(SESSION_WORKBENCH_TAB_ID);
  });

  it('localizes the tab title without changing its identity', () => {
    setCurrentLanguage('en-US');
    const tab = buildSessionWorkbenchTab();
    expect(tab.title).toBe('Session Workbench');
    expect(tab.id).toBe(SESSION_WORKBENCH_TAB_ID);
    expect(tab.connectionId).toBe('');
    expect(tab.dbName).toBeUndefined();
  });
});
