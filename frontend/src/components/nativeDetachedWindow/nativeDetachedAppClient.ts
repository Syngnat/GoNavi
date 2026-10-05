import { type SqlLog, useStore } from '../../store';
import type { TabData } from '../../types';
import type { DetachedQueryResultWindow } from '../../utils/detachedWindow';
import {
  type NativeDetachedWindowBootstrap,
  type NativeDetachedWindowActionPayload,
  fetchNativeDetachedWindowBootstrap,
  presentCurrentNativeDetachedWindow,
  readyNativeDetachedWindow,
  syncNativeDetachedWindow,
  attachNativeDetachedWindow,
  hideNativeDetachedWindow,
  closeNativeDetachedWindow,
  cancelNativeDetachedWindowClose,
  hideCurrentNativeDetachedWindowForAISettings,
  sendNativeDetachedHostEvent,
  closeCurrentNativeDetachedWindow,
  hideCurrentNativeDetachedWindow,
  cancelCurrentNativeDetachedWindowClose,
  type NativeDetachedStoreSnapshot,
  buildNativeDetachedAIChatSyncStoreSnapshot,
  buildNativeDetachedSyncStoreSnapshot,
} from '../../utils/nativeDetachedWindowClient';
import type { QueryEditorResultSessionSnapshot } from '../../utils/queryEditorResultSessionCache';

export type NativeDetachedWindowClient = {
  load: () => Promise<NativeDetachedWindowBootstrap>;
  present?: () => Promise<void>;
  ready: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  sync: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  attach: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  hide?: (payload: NativeDetachedWindowActionPayload) => Promise<number>;
  close: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  cancelCloseRequest?: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  openAISettings: (visibilityRevision: number, providerId?: string) => Promise<void>;
  hostEvent?: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  closeCurrentWindow: () => Promise<void>;
  hideCurrentWindow?: (visibilityRevision: number) => Promise<void>;
  cancelClose?: () => Promise<void>;
};

export const defaultClient: NativeDetachedWindowClient = {
  load: fetchNativeDetachedWindowBootstrap,
  present: presentCurrentNativeDetachedWindow,
  ready: readyNativeDetachedWindow,
  sync: syncNativeDetachedWindow,
  attach: attachNativeDetachedWindow,
  hide: hideNativeDetachedWindow,
  close: closeNativeDetachedWindow,
  cancelCloseRequest: cancelNativeDetachedWindowClose,
  openAISettings: hideCurrentNativeDetachedWindowForAISettings,
  hostEvent: sendNativeDetachedHostEvent,
  closeCurrentWindow: closeCurrentNativeDetachedWindow,
  hideCurrentWindow: hideCurrentNativeDetachedWindow,
  cancelClose: cancelCurrentNativeDetachedWindowClose,
};

export const buildActionPayload = (
  bootstrap: NativeDetachedWindowBootstrap,
  tab?: TabData,
  resultSession?: QueryEditorResultSessionSnapshot | null,
  includeResultSession = false,
  newSqlLogs: SqlLog[] = [],
  revision?: number,
  workbenchState?: NativeDetachedStoreSnapshot,
  workbenchStateBase?: NativeDetachedStoreSnapshot,
  openedTabs: TabData[] = [],
  clearSqlLogs = false,
  resultWindow?: DetachedQueryResultWindow | null,
): NativeDetachedWindowActionPayload => {
  const storeState = bootstrap.kind === 'ai-chat'
    ? buildNativeDetachedAIChatSyncStoreSnapshot(useStore.getState(), newSqlLogs)
    : buildNativeDetachedSyncStoreSnapshot(
        useStore.getState(),
        bootstrap.kind === 'workbench' ? bootstrap.payload.tab?.id || '' : '',
        newSqlLogs,
      );
  const screenX = typeof window === 'undefined' ? Number.NaN : Number(window.screenX);
  const screenY = typeof window === 'undefined' ? Number.NaN : Number(window.screenY);
  const width = typeof window === 'undefined'
    ? Number.NaN
    : Number(window.outerWidth || window.innerWidth);
  const height = typeof window === 'undefined'
    ? Number.NaN
    : Number(window.outerHeight || window.innerHeight);
  const bounds = [screenX, screenY, width, height].every(Number.isFinite)
    && width > 0
    && height > 0
    ? {
        x: Math.round(screenX),
        y: Math.round(screenY),
        width: Math.round(width),
        height: Math.round(height),
      }
    : undefined;
  return {
    id: bootstrap.id,
    kind: bootstrap.kind,
    ...(revision && revision > 0 ? { revision } : {}),
    ...(bounds ? { bounds } : {}),
    ...(workbenchState && Object.keys(workbenchState).length > 0 ? { workbenchState } : {}),
    ...(workbenchState && Object.keys(workbenchState).length > 0
      ? { workbenchStateBase: workbenchStateBase ?? {} }
      : {}),
    ...(openedTabs.length > 0 ? { openedTabs } : {}),
    ...(clearSqlLogs ? { clearSqlLogs: true } : {}),
    ...(bootstrap.kind === 'workbench' || Object.keys(storeState).length > 0
      ? { storeState }
      : {}),
    ...(tab ? { tab } : {}),
    ...(bootstrap.kind === 'query-result' && resultWindow ? { resultWindow } : {}),
    ...(bootstrap.kind === 'workbench' && includeResultSession
      ? { resultSession: resultSession ?? null }
      : {}),
  };
};
