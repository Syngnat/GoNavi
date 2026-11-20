import type { TabData } from '../types';
import type { ScriptVisibility } from '../components/scriptWorkbench/scriptWorkbenchTypes';

export const SCRIPT_WORKBENCH_TAB_ID = 'script-workbench';
export const SCRIPT_WORKBENCH_OPEN_EVENT = 'gonavi:open-script-workbench';

export interface OpenScriptWorkbenchRequest {
  scriptId?: string;
  folderId?: string;
  visibility?: ScriptVisibility;
  displayName?: string;
  source?: string;
  connectionId?: string;
  dbName?: string;
  requestKey?: string;
  title: string;
}

const shortHash = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const buildScriptWorkbenchTabId = ({
  scriptId,
  requestKey,
  source,
}: Pick<OpenScriptWorkbenchRequest, 'scriptId' | 'requestKey' | 'source'>): string => {
  if (scriptId) return `${SCRIPT_WORKBENCH_TAB_ID}:${scriptId}`;
  if (requestKey) return `${SCRIPT_WORKBENCH_TAB_ID}:${requestKey}`;
  if (source?.trim()) return `${SCRIPT_WORKBENCH_TAB_ID}:draft:${shortHash(source)}`;
  return `${SCRIPT_WORKBENCH_TAB_ID}:new`;
};

export const buildScriptWorkbenchTab = (
  request: OpenScriptWorkbenchRequest,
): TabData => ({
  id: buildScriptWorkbenchTabId(request),
  title: request.displayName?.trim() || request.title,
  type: 'script-workbench',
  connectionId: String(request.connectionId || '').trim(),
  dbName: String(request.dbName || '').trim() || undefined,
  scriptId: request.scriptId,
  scriptFolderId: request.folderId,
  scriptVisibility: request.visibility,
  scriptDisplayName: request.displayName?.trim() || undefined,
  scriptPreviewSource: request.source,
  preserveUnboundConnection: true,
});

export const resolveScriptWorkbenchNodeConnectionId = (
  node: {
    type?: string;
    key?: string;
    dataRef?: { id?: string; connectionId?: string };
  } | null | undefined,
  connections: readonly { id: string }[],
): string => {
  const candidates = [
    node?.dataRef?.connectionId,
    node?.type === 'connection' ? node?.key : '',
    node?.dataRef?.id,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return candidates.find((candidate) => connections.some((connection) => connection.id === candidate)) || '';
};

export const SCRIPT_WORKBENCH_TAB_TITLE_KEY = 'script_workbench.title';

export type OpenScriptWorkbenchEventDetail = {
  scriptId?: unknown;
  folderId?: unknown;
  visibility?: unknown;
  displayName?: unknown;
  source?: unknown;
  connectionId?: unknown;
  dbName?: unknown;
  requestKey?: unknown;
};
