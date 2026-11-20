import { useEffect } from 'react';
import { t } from '../../i18n';
import {
  SCRIPT_WORKBENCH_OPEN_EVENT,
  buildScriptWorkbenchTab,
  type OpenScriptWorkbenchEventDetail,
} from '../../utils/scriptWorkbenchTab';
import { useStore } from '../../store';

export const useScriptWorkbenchOpenRequest = (): void => {
  useEffect(() => {
    const handleOpenScriptWorkbench = (event: Event) => {
      const detail = (event as CustomEvent<OpenScriptWorkbenchEventDetail>).detail || {};
      const source = typeof detail.source === 'string' ? detail.source : '';
      const scriptId = String(detail.scriptId || '').trim();
      if (!source.trim() && !scriptId) return;
      const visibility = detail.visibility === 'shared' ? 'shared' : detail.visibility === 'private' ? 'private' : undefined;
      useStore.getState().addTab(buildScriptWorkbenchTab({
        scriptId: scriptId || undefined,
        folderId: String(detail.folderId || '').trim() || undefined,
        visibility,
        displayName: String(detail.displayName || '').trim() || undefined,
        source: source || undefined,
        connectionId: String(detail.connectionId || '').trim(),
        dbName: String(detail.dbName || '').trim(),
        requestKey: String(detail.requestKey || '').trim() || undefined,
        title: t('script_workbench.title'),
      }));
    };
    window.addEventListener(SCRIPT_WORKBENCH_OPEN_EVENT, handleOpenScriptWorkbench as EventListener);
    return () => {
      window.removeEventListener(SCRIPT_WORKBENCH_OPEN_EVENT, handleOpenScriptWorkbench as EventListener);
    };
  }, []);
};
