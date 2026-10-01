import type { TabData } from '../types';
import { t } from '../i18n';

export const SESSION_WORKBENCH_TAB_ID = 'session-workbench-center';

export interface SessionWorkbenchTabInput {
  connectionId?: string;
  dbName?: string;
}

export const buildSessionWorkbenchTab = (
  input: SessionWorkbenchTabInput = {},
): TabData => {
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  return {
    id: SESSION_WORKBENCH_TAB_ID,
    title: t('session_workbench.title'),
    type: 'session-workbench',
    connectionId,
    ...(dbName ? { dbName } : {}),
  };
};
