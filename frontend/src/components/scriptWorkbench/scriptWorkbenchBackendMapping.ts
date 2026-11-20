import type {
  ScriptCellValue,
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptLibrarySnapshot,
  ScriptOutputPage,
  ScriptResultRow,
  ScriptVisibility,
} from './scriptWorkbenchTypes';
import type {
  BackendOutputPage,
  BackendScript,
  BackendSnapshot,
} from './scriptWorkbenchBackendTypes';

const normalizeVisibility = (value: unknown): ScriptVisibility => (
  value === 'shared' ? 'shared' : 'private'
);

export const normalizeScript = (value: BackendScript): ScriptLibraryScript => ({
  id: String(value?.id || ''),
  name: String(value?.name || ''),
  description: String(value?.description || ''),
  code: String(value?.code || ''),
  owner: String(value?.owner || ''),
  visibility: normalizeVisibility(value?.visibility),
  folderId: String(value?.folderId || '') || undefined,
  connections: Array.isArray(value?.connections) ? value.connections : [],
  inputs: Array.isArray(value?.inputs) ? value.inputs : [],
  allowWrite: value?.allowWrite === true,
  batchSize: Math.max(1, Math.floor(Number(value?.batchSize) || 500)),
  inListLimit: Math.max(1, Math.floor(Number(value?.inListLimit) || 1_000)),
  ...(value?.runLimits && typeof value.runLimits === 'object'
    ? { runLimits: { ...value.runLimits } }
    : {}),
  revision: Math.max(0, Math.floor(Number(value?.revision) || 0)),
  canEdit: typeof value?.canEdit === 'boolean' ? value.canEdit : undefined,
  canShare: typeof value?.canShare === 'boolean' ? value.canShare : undefined,
  createdAt: Number(value?.createdAt) || 0,
  updatedAt: Number(value?.updatedAt) || 0,
});

export const normalizeFolder = (
  value: Partial<ScriptLibraryFolder>,
): ScriptLibraryFolder => ({
  id: String(value?.id || ''),
  name: String(value?.name || ''),
  parentId: String(value?.parentId || '') || undefined,
  owner: String(value?.owner || ''),
  visibility: normalizeVisibility(value?.visibility),
  revision: Math.max(0, Math.floor(Number(value?.revision) || 0)),
  canEdit: typeof value?.canEdit === 'boolean' ? value.canEdit : undefined,
  canShare: typeof value?.canShare === 'boolean' ? value.canShare : undefined,
  createdAt: Number(value?.createdAt) || 0,
  updatedAt: Number(value?.updatedAt) || 0,
});

export const normalizeSnapshot = (
  value: BackendSnapshot | null | undefined,
): ScriptLibrarySnapshot => ({
  owner: String(value?.owner || ''),
  scripts: (Array.isArray(value?.scripts) ? value.scripts : []).map(normalizeScript),
  folders: (Array.isArray(value?.folders) ? value.folders : []).map(normalizeFolder),
  canWrite: value?.canWrite === true,
  canShare: value?.canShare === true && value?.sharedScriptingDisabled !== true,
  sharedOnly: value?.sharedOnly === true,
  canManageShared: value?.canManageShared === true,
  sharedScriptingDisabled: value?.sharedScriptingDisabled === true,
});

const normalizeCell = (value: unknown): ScriptCellValue => {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizeRows = (rows: unknown): ScriptResultRow[] => (
  (Array.isArray(rows) ? rows : []).map((row) => {
    const result: ScriptResultRow = {};
    Object.entries((row || {}) as Record<string, unknown>).forEach(([key, value]) => {
      result[key] = normalizeCell(value);
    });
    return result;
  })
);

export const mapOutputPage = (
  runId: string,
  value: BackendOutputPage,
): ScriptOutputPage => {
  const rows = normalizeRows(value?.rows);
  const columns = Array.from(new Set([
    ...(Array.isArray(value?.columns) ? value.columns.map(String) : []),
    ...rows.flatMap((row) => Object.keys(row)),
  ]));
  return {
    outputId: `${runId}:${Math.max(0, Math.floor(Number(value?.outputIndex) || 0))}`,
    name: String(value?.name || ''),
    columns,
    rows,
    page: Math.max(1, Math.floor(Number(value?.page) || 1)),
    pageSize: Math.max(1, Math.floor(Number(value?.pageSize) || 100)),
    totalRows: Math.max(0, Math.floor(Number(value?.total) || 0)),
    truncated: value?.truncated === true,
  };
};
