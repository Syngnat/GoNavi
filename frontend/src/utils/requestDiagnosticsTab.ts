import type { TabData } from '../types';

export const REQUEST_DIAGNOSTICS_WORKBENCH_TAB_ID = 'request-diagnostics-center';

export const buildRequestDiagnosticsWorkbenchTab = (): TabData => ({
  id: REQUEST_DIAGNOSTICS_WORKBENCH_TAB_ID,
  title: '请求诊断',
  type: 'request-diagnostics',
  connectionId: '',
});
