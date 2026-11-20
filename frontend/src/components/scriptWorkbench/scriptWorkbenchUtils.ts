import type { SavedConnection } from '../../types';
import { resolveConnectionEnvironmentType } from '../../utils/connectionEnvironment';
import { isWebRuntime } from '../../utils/browserFileTransfer';
import type {
  ScriptConnectionBinding,
  ScriptDraft,
  ScriptInputBinding,
  ScriptLibraryScript,
  ScriptRunLimitValues,
  ScriptRunLimits,
} from './scriptWorkbenchTypes';
import {
  normalizeScriptAlias,
  uniqueScriptAlias,
} from './scriptWorkbenchValidation';
import { createScriptDraftInstanceId } from './scriptWorkbenchIds';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export const SCRIPT_WORKBENCH_FONT_STACK = 'var(--gn-font-mono, ui-monospace, monospace)';

export const SCRIPT_RUN_LIMITS: ScriptRunLimits = {
  timeoutMs: 30 * 60 * 1000,
  maxDbCalls: 10_000,
  maxOutputRows: 50_000,
  memoryLimitBytes: 512 << 20,
  defaultBatch: 500,
  maxBatch: 5_000,
  defaultInList: 1_000,
  maxInList: 1_000,
  defaultQueryRows: 10_000,
  maxQueryRows: 200_000,
};

export const SCRIPT_DESKTOP_TIMEOUT_MS = 30 * 60 * 1000;
export const SCRIPT_WEB_TIMEOUT_MS = 10 * 60 * 1000;
const SCRIPT_MIN_TIMEOUT_MS = 60 * 1000;
const SCRIPT_MAX_DESKTOP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SCRIPT_MAX_WEB_TIMEOUT_MS = 30 * 60 * 1000;
const SCRIPT_MIN_MEMORY_BYTES = 64 << 20;
const SCRIPT_MAX_DESKTOP_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const SCRIPT_MAX_WEB_MEMORY_BYTES = 1 << 30;

export interface ScriptRunLimitBound {
  min: number;
  max: number;
  default: number;
}

export interface ScriptRunLimitBounds {
  timeoutMs: ScriptRunLimitBound;
  maxDbCalls: ScriptRunLimitBound;
  maxOutputRows: ScriptRunLimitBound;
  memoryLimitBytes: ScriptRunLimitBound;
}

export const resolveScriptRunLimits = (webRuntime = isWebRuntime()): ScriptRunLimits => ({
  ...SCRIPT_RUN_LIMITS,
  timeoutMs: webRuntime ? SCRIPT_WEB_TIMEOUT_MS : SCRIPT_DESKTOP_TIMEOUT_MS,
});

export const resolveScriptRunLimitBounds = (
  webRuntime = isWebRuntime(),
): ScriptRunLimitBounds => ({
  timeoutMs: {
    min: SCRIPT_MIN_TIMEOUT_MS,
    max: webRuntime ? SCRIPT_MAX_WEB_TIMEOUT_MS : SCRIPT_MAX_DESKTOP_TIMEOUT_MS,
    default: webRuntime ? SCRIPT_WEB_TIMEOUT_MS : SCRIPT_DESKTOP_TIMEOUT_MS,
  },
  maxDbCalls: { min: 1, max: 100_000, default: 10_000 },
  maxOutputRows: { min: 1, max: 200_000, default: 50_000 },
  memoryLimitBytes: {
    min: SCRIPT_MIN_MEMORY_BYTES,
    max: webRuntime ? SCRIPT_MAX_WEB_MEMORY_BYTES : SCRIPT_MAX_DESKTOP_MEMORY_BYTES,
    default: 512 << 20,
  },
});

const clampRunLimitValue = (
  value: number | undefined,
  bound: ScriptRunLimitBound,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return bound.default;
  return Math.max(bound.min, Math.min(bound.max, Math.trunc(numeric)));
};

export const resolveScriptRunLimitValues = (
  value?: ScriptRunLimitValues | null,
  webRuntime = isWebRuntime(),
): Required<ScriptRunLimitValues> => {
  const bounds = resolveScriptRunLimitBounds(webRuntime);
  return {
    timeoutMs: clampRunLimitValue(value?.timeoutMs, bounds.timeoutMs),
    maxDbCalls: clampRunLimitValue(value?.maxDbCalls, bounds.maxDbCalls),
    maxOutputRows: clampRunLimitValue(value?.maxOutputRows, bounds.maxOutputRows),
    memoryLimitBytes: clampRunLimitValue(value?.memoryLimitBytes, bounds.memoryLimitBytes),
  };
};

export const resolveDraftRunLimits = (
  draft: Pick<ScriptDraft, 'runLimits'>,
  webRuntime = isWebRuntime(),
): Required<ScriptRunLimitValues> => (
  resolveScriptRunLimitValues(draft.runLimits, webRuntime)
);

export const resolveRunLimitsForRequest = (draft: ScriptDraft): ScriptRunLimits => {
  const values = resolveDraftRunLimits(draft);
  return {
    ...resolveScriptRunLimits(),
    ...values,
    defaultBatch: draft.batchSize,
    defaultInList: draft.inListLimit,
    defaultQueryRows: Math.min(SCRIPT_RUN_LIMITS.defaultQueryRows, values.maxOutputRows),
    maxQueryRows: values.maxOutputRows,
  };
};

export const SCRIPT_STARTER_SOURCE = `const result = gonavi.db.query("prod", {
  sql: "SELECT 1 AS ok",
  maxRows: 100,
});

gonavi.output("result", result.rows);
`;

export const scriptSourceHash = (source: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const scriptSourceBytes = (source: string): number => (
  typeof TextEncoder === 'undefined' ? source.length : new TextEncoder().encode(source).length
);

export const formatScriptBytes = (bytes: number): string => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export const formatScriptDuration = (milliseconds: number): string => {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
};

export const scriptLineCount = (source: string): number => (
  source ? source.split('\n').length : 1
);

export const buildConnectionBindings = (
  connectionIds: readonly string[],
  connections: readonly SavedConnection[],
  preferredDatabase?: string,
): ScriptConnectionBinding[] => {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const usedAliases = new Set<string>();
  const tabDatabase = String(preferredDatabase || '').trim();
  return connectionIds
    .map((connectionId, index) => {
      const connection = byId.get(connectionId);
      const database = index === 0 && tabDatabase
        ? tabDatabase
        : resolveScriptConnectionDatabase(connection);
      const alias = uniqueScriptAlias(
        normalizeScriptAlias(connection?.name || '', `db${index + 1}`),
        usedAliases,
      );
      usedAliases.add(alias);
      return {
        alias,
        connectionId,
        ...(database ? { database } : {}),
      };
    })
    .filter((binding) => Boolean(binding.connectionId));
};

export const resolveScriptConnectionDatabase = (
  connection: SavedConnection | undefined,
): string => {
  if (!connection) return '';
  const type = String(connection.config?.type || '').trim().toLowerCase();
  const oracleProtocol = type === 'oracle'
    || (type === 'oceanbase' && String(connection.config?.oceanBaseProtocol || '').toLowerCase() === 'oracle');
  if (oracleProtocol) return '';
  return String(connection.config?.database || '').trim();
};

export const buildInitialDraft = ({
  tab,
  defaultName,
  source,
  connectionIds,
  connections,
}: {
  tab: {
    scriptId?: string;
    scriptFolderId?: string;
    scriptVisibility?: 'private' | 'shared';
    scriptPreviewSource?: string;
    dbName?: string;
  };
  defaultName: string;
  source: string;
  connectionIds: readonly string[];
  connections: readonly SavedConnection[];
}): ScriptDraft => {
  const bindings = buildConnectionBindings(connectionIds, connections, tab.dbName);
  const initialSource = tab.scriptPreviewSource
    || scriptSourceWithPrimaryAlias(source, bindings[0]?.alias);
  return {
    draftInstanceId: createScriptDraftInstanceId(),
    id: tab.scriptId,
    name: defaultName,
    description: '',
    source: initialSource,
    visibility: tab.scriptVisibility === 'shared' ? 'shared' : 'private',
    folderId: tab.scriptFolderId,
    revision: 0,
    connections: bindings,
    inputs: [],
    allowWrite: false,
    batchSize: SCRIPT_RUN_LIMITS.defaultBatch,
    inListLimit: SCRIPT_RUN_LIMITS.defaultInList,
  };
};

export const scriptSourceWithPrimaryAlias = (source: string, alias?: string): string => (
  alias?.trim() ? source.replace('"prod"', JSON.stringify(alias.trim())) : source
);

export const draftFromScript = (
  script: ScriptLibraryScript,
  draftInstanceId = createScriptDraftInstanceId(),
): ScriptDraft => ({
  draftInstanceId,
  id: script.id,
  owner: script.owner,
  canEdit: script.canEdit,
  canShare: script.canShare,
  name: script.name,
  description: script.description || '',
  source: script.code,
  visibility: script.visibility,
  folderId: script.folderId,
  revision: script.revision,
  connections: script.connections || [],
  inputs: script.inputs || [],
  allowWrite: script.allowWrite === true,
  batchSize: script.batchSize || SCRIPT_RUN_LIMITS.defaultBatch,
  inListLimit: script.inListLimit || SCRIPT_RUN_LIMITS.defaultInList,
  ...(script.runLimits ? { runLimits: script.runLimits } : {}),
});

export const scriptFromDraft = (
  draft: ScriptDraft,
  base?: ScriptLibraryScript,
): ScriptLibraryScript => ({
  id: draft.id || base?.id || '',
  name: draft.name,
  description: draft.description || '',
  code: draft.source,
  owner: base?.owner || draft.owner || '',
  visibility: draft.visibility,
  folderId: draft.folderId,
  connections: draft.connections,
  inputs: draft.inputs,
  allowWrite: draft.allowWrite,
  batchSize: draft.batchSize,
  inListLimit: draft.inListLimit,
  ...(draft.runLimits ? { runLimits: draft.runLimits } : {}),
  revision: draft.revision,
  canEdit: base?.canEdit ?? draft.canEdit,
  canShare: base?.canShare ?? draft.canShare,
  createdAt: base?.createdAt || 0,
  updatedAt: base?.updatedAt || 0,
});

const signatureText = (values: readonly string[]): string => (
  values.slice().sort().join('\u0001')
);

export const scriptConnectionSignature = (
  connections: readonly ScriptConnectionBinding[],
): string => signatureText(connections.map((binding) => [
  String(binding.alias || '').trim(),
  String(binding.connectionId || '').trim(),
  String(binding.database || '').trim(),
].join('\u0000')));

export const scriptInputSignature = (
  inputs: readonly ScriptInputBinding[],
): string => signatureText(inputs.map((input) => [
  String(input.alias || '').trim(),
  String(input.path || '').trim(),
  String(input.reference || '').trim(),
  String(input.name || '').trim(),
  String(input.sheetName || '').trim(),
  String(input.encoding || '').trim(),
  String(input.delimiter || '').trim(),
  String(input.headerRow || '').trim(),
].join('\u0000')));

export interface ScriptDraftExecutionFingerprint {
  scriptId: string;
  sourceHash: string;
  sourceLength: number;
  connectionSignature: string;
  inputSignature: string;
  runLimitsSignature: string;
  allowWrite: boolean;
  batchSize: number;
  inListLimit: number;
}

export const buildScriptDraftFingerprint = (
  draft: ScriptDraft,
  allowWrite = draft.allowWrite,
): ScriptDraftExecutionFingerprint => ({
  scriptId: String(draft.id || ''),
  sourceHash: scriptSourceHash(draft.source),
  sourceLength: draft.source.length,
  connectionSignature: scriptConnectionSignature(draft.connections),
  inputSignature: scriptInputSignature(draft.inputs),
  runLimitsSignature: Object.values(resolveDraftRunLimits(draft)).join('\u0000'),
  allowWrite,
  batchSize: draft.batchSize,
  inListLimit: draft.inListLimit,
});

export const sameScriptDraftFingerprint = (
  left: ScriptDraftExecutionFingerprint,
  right: ScriptDraftExecutionFingerprint,
): boolean => (
  left.scriptId === right.scriptId
  && left.sourceHash === right.sourceHash
  && left.sourceLength === right.sourceLength
  && left.connectionSignature === right.connectionSignature
  && left.inputSignature === right.inputSignature
  && left.runLimitsSignature === right.runLimitsSignature
  && left.allowWrite === right.allowWrite
  && left.batchSize === right.batchSize
  && left.inListLimit === right.inListLimit
);

export const fillScriptDraftContext = ({
  draft,
  connectionId,
  dbName,
  connections,
  allowAddConnection = true,
  allowBindMissingConnection = true,
}: {
  draft: ScriptDraft;
  connectionId?: string;
  dbName?: string;
  connections: readonly SavedConnection[];
  allowAddConnection?: boolean;
  allowBindMissingConnection?: boolean;
}): ScriptDraft => {
  const tabConnectionId = String(connectionId || '').trim();
  const tabDatabase = String(dbName || '').trim();
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const canBindOneMissing = allowBindMissingConnection && draft.connections.length <= 1;
  let changed = false;
  let connectionsNext = draft.connections.map((binding) => {
    let next = binding;
    if (canBindOneMissing && !String(next.connectionId || '').trim() && tabConnectionId) {
      next = { ...next, connectionId: tabConnectionId };
      changed = true;
    }
    if (!String(next.database || '').trim()) {
      const database = (
        next.connectionId === tabConnectionId ? tabDatabase : ''
      )
        || resolveScriptConnectionDatabase(byId.get(String(next.connectionId || '')))
        || (!next.connectionId ? tabDatabase : '');
      if (database) {
        next = { ...next, database };
        changed = true;
      }
    }
    return next;
  });
  if (connectionsNext.length === 0 && tabConnectionId && allowAddConnection) {
    connectionsNext = buildConnectionBindings([tabConnectionId], connections, tabDatabase);
    changed = connectionsNext.length > 0;
  }
  return changed ? { ...draft, connections: connectionsNext } : draft;
};

export const scriptToDraftConnections = (
  script: ScriptLibraryScript,
): ScriptConnectionBinding[] => script.connections || [];

export const describeConnectionEnvironment = (connection: SavedConnection | undefined): 'production' | 'test' | 'development' | 'local' => (
  resolveConnectionEnvironmentType(connection)
);

export const inputDisplayName = (input: ScriptInputBinding | null | undefined): string => (
  String(input?.name || input?.reference || input?.path || '').trim()
);

export const isXlsxInput = (input: ScriptInputBinding | null | undefined): boolean => (
  /\.xlsx$/i.test(inputDisplayName(input))
);

export const inputBindingKey = (input: ScriptInputBinding): string => (
  `${input.alias}\u0000${input.path || input.reference || input.name || ''}`
);

export const buildScriptAiPrompt = ({
  t,
  draft,
  connectionNames,
  fileNames,
}: {
  t: Translate;
  draft: ScriptDraft;
  connectionNames: string[];
  fileNames?: readonly string[];
}): string => t('script_workbench.ai.prompt', {
  code: draft.source,
  connections: connectionNames.join(', ') || '-',
  file: (fileNames || []).filter(Boolean).join(', ') || '-',
  batchSize: draft.batchSize,
  inListLimit: draft.inListLimit,
});
