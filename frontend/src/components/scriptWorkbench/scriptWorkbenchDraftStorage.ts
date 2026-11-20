import type {
  ScriptConnectionBinding,
  ScriptDraft,
  ScriptInputBinding,
  ScriptRunLimitValues,
  ScriptVisibility,
} from './scriptWorkbenchTypes';
import { normalizeScriptAlias } from './scriptWorkbenchValidation';
import { createScriptDraftInstanceId } from './scriptWorkbenchIds';

export const SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY = 'gonavi-script-workbench-drafts-v1';

const STORAGE_VERSION = 1;
const MAX_ENTRIES = 32;
export const MAX_SCRIPT_DRAFT_SOURCE_BYTES = 256 * 1024;
export const MAX_SCRIPT_DRAFT_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_BINDINGS = 32;
const MAX_TEXT_LENGTH = 8 * 1024;
const MAX_SHORT_TEXT_LENGTH = 512;

export type ScriptWorkbenchDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ScriptDraftStorageFailure =
  | 'invalid'
  | 'source_too_large'
  | 'quota'
  | 'unavailable';

export type ScriptDraftSaveResult =
  | { ok: true; bytes: number; entries: number }
  | { ok: false; reason: ScriptDraftStorageFailure; bytes?: number };

type StoredDraft = {
  tabId: string;
  updatedAt: number;
  draft: ScriptDraft;
};

type StoredEnvelope = {
  version: typeof STORAGE_VERSION;
  entries: StoredDraft[];
};

const text = (value: unknown, maxLength: number): string => (
  typeof value === 'string' ? value.slice(0, maxLength) : ''
);

const byteLength = (value: string): number => (
  typeof TextEncoder === 'undefined' ? value.length * 2 : new TextEncoder().encode(value).length
);

const shortText = (value: unknown): string => String(value ?? '').trim().slice(0, MAX_SHORT_TEXT_LENGTH);

const optionalText = (value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined => {
  const normalized = text(value, maxLength).trim();
  return normalized || undefined;
};

const asVisibility = (value: unknown): ScriptVisibility => (
  value === 'shared' ? 'shared' : 'private'
);

const asBoundedInt = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
};

const asPositiveBoundedInt = (value: unknown, minimum: number, maximum: number): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
};

const normalizeBinding = (value: unknown): ScriptConnectionBinding | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const alias = normalizeScriptAlias(raw.alias, '');
  if (!alias) return null;
  return {
    alias,
    ...(optionalText(raw.connectionId, MAX_SHORT_TEXT_LENGTH) ? {
      connectionId: optionalText(raw.connectionId, MAX_SHORT_TEXT_LENGTH),
    } : {}),
    ...(optionalText(raw.database) ? { database: optionalText(raw.database) } : {}),
  };
};

const normalizeInput = (value: unknown): ScriptInputBinding | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const alias = normalizeScriptAlias(raw.alias, '');
  if (!alias) return null;
  const normalized: ScriptInputBinding = { alias };
  const path = optionalText(raw.path, 8192);
  const reference = optionalText(raw.reference, 1024);
  const name = optionalText(raw.name, MAX_TEXT_LENGTH);
  const sheetName = optionalText(raw.sheetName, MAX_TEXT_LENGTH);
  const encoding = optionalText(raw.encoding, MAX_SHORT_TEXT_LENGTH);
  const delimiter = optionalText(raw.delimiter, 16);
  if (path) normalized.path = path;
  if (reference) normalized.reference = reference;
  if (name) normalized.name = name;
  if (sheetName) normalized.sheetName = sheetName;
  if (encoding) normalized.encoding = encoding;
  if (delimiter) normalized.delimiter = delimiter;
  const headerRow = asBoundedInt(raw.headerRow, 1, 1, 1_000_000);
  normalized.headerRow = headerRow;
  return normalized;
};

const normalizeRunLimits = (value: unknown): ScriptRunLimitValues | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const timeoutMs = asPositiveBoundedInt(raw.timeoutMs, 60_000, 7_200_000);
  const maxDbCalls = asPositiveBoundedInt(raw.maxDbCalls, 1, 100_000);
  const maxOutputRows = asPositiveBoundedInt(raw.maxOutputRows, 1, 200_000);
  const memoryLimitBytes = asPositiveBoundedInt(
    raw.memoryLimitBytes,
    64 << 20,
    2 * 1024 * 1024 * 1024,
  );
  if (!timeoutMs && !maxDbCalls && !maxOutputRows && !memoryLimitBytes) return undefined;
  return {
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxDbCalls ? { maxDbCalls } : {}),
    ...(maxOutputRows ? { maxOutputRows } : {}),
    ...(memoryLimitBytes ? { memoryLimitBytes } : {}),
  };
};

const normalizeDraft = (value: unknown): {
  draft: ScriptDraft | null;
  reason?: ScriptDraftStorageFailure;
} => {
  if (!value || typeof value !== 'object') return { draft: null, reason: 'invalid' };
  const raw = value as Record<string, unknown>;
  const source = typeof raw.source === 'string' ? raw.source : '';
  if (byteLength(source) > MAX_SCRIPT_DRAFT_SOURCE_BYTES) {
    return { draft: null, reason: 'source_too_large' };
  }
  const name = text(raw.name, MAX_NAME_LENGTH).trim();
  if (!name && !source) return { draft: null, reason: 'invalid' };
  const connections = Array.isArray(raw.connections)
    ? raw.connections.map(normalizeBinding).filter((item): item is ScriptConnectionBinding => Boolean(item)).slice(0, MAX_BINDINGS)
    : [];
  const inputs = Array.isArray(raw.inputs)
    ? raw.inputs.map(normalizeInput).filter((item): item is ScriptInputBinding => Boolean(item)).slice(0, MAX_BINDINGS)
    : [];
  const runLimits = normalizeRunLimits(raw.runLimits);
  return { draft: {
    draftInstanceId: shortText(raw.draftInstanceId) || createScriptDraftInstanceId(),
    ...(optionalText(raw.id, MAX_TEXT_LENGTH) ? { id: optionalText(raw.id, MAX_TEXT_LENGTH) } : {}),
    name,
    description: text(raw.description, MAX_DESCRIPTION_LENGTH).trim(),
    source,
    visibility: asVisibility(raw.visibility),
    ...(optionalText(raw.folderId) ? { folderId: optionalText(raw.folderId) } : {}),
    revision: asBoundedInt(raw.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    connections,
    inputs,
    allowWrite: raw.allowWrite === true,
    batchSize: asBoundedInt(raw.batchSize, 500, 1, 5_000),
    inListLimit: asBoundedInt(raw.inListLimit, 1_000, 1, 1_000),
    ...(runLimits ? { runLimits } : {}),
  } };
};

const resolveStorage = (storage?: ScriptWorkbenchDraftStorage): ScriptWorkbenchDraftStorage | null => {
  if (storage) return storage;
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

const emptyEnvelope = (): StoredEnvelope => ({ version: STORAGE_VERSION, entries: [] });

const parseEnvelope = (raw: string | null): StoredEnvelope => {
  if (!raw) return emptyEnvelope();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredEnvelope> | null;
    if (!parsed || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.entries)) {
      return emptyEnvelope();
    }
    const entries = parsed.entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const candidate = entry as Partial<StoredDraft>;
        const tabId = shortText(candidate.tabId);
        const normalized = normalizeDraft(candidate.draft);
        const draft = normalized.draft;
        if (!tabId || !draft) return null;
        const updatedAt = Number(candidate.updatedAt);
        return {
          tabId,
          draft,
          updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : 0,
        } satisfies StoredDraft;
      })
      .filter((entry): entry is StoredDraft => Boolean(entry))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ENTRIES);
    return { version: STORAGE_VERSION, entries };
  } catch {
    return emptyEnvelope();
  }
};

const writeEnvelope = (
  storage: ScriptWorkbenchDraftStorage,
  envelope: StoredEnvelope,
): ScriptDraftSaveResult => {
  const serialized = envelope.entries.length === 0 ? '' : JSON.stringify(envelope);
  const bytes = byteLength(serialized);
  if (bytes > MAX_SCRIPT_DRAFT_TOTAL_BYTES) {
    return { ok: false, reason: 'invalid', bytes };
  }
  try {
    if (envelope.entries.length === 0) {
      storage.removeItem(SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY);
    } else {
      storage.setItem(SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY, serialized);
    }
    return { ok: true, bytes, entries: envelope.entries.length };
  } catch {
    return { ok: false, reason: 'quota', bytes };
  }
};

export const loadScriptWorkbenchDraft = (
  tabId: string,
  scriptId?: string,
  storage?: ScriptWorkbenchDraftStorage,
): ScriptDraft | null => {
  const normalizedTabId = shortText(tabId);
  const resolvedStorage = resolveStorage(storage);
  if (!normalizedTabId || !resolvedStorage) return null;
  const entry = parseEnvelope(resolvedStorage.getItem(SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY))
    .entries.find((candidate) => candidate.tabId === normalizedTabId);
  if (!entry) return null;
  const expectedScriptId = shortText(scriptId);
  const storedScriptId = shortText(entry.draft.id);
  if (expectedScriptId !== storedScriptId) return null;
  return entry.draft;
};

export const saveScriptWorkbenchDraft = (
  tabId: string,
  draft: ScriptDraft,
  storage?: ScriptWorkbenchDraftStorage,
): ScriptDraftSaveResult => {
  const normalizedTabId = shortText(tabId);
  const normalized = normalizeDraft(draft);
  const normalizedDraft = normalized.draft;
  const resolvedStorage = resolveStorage(storage);
  if (!normalizedTabId) return { ok: false, reason: 'invalid' };
  if (normalized.reason) return { ok: false, reason: normalized.reason };
  if (!normalizedDraft) return { ok: false, reason: 'invalid' };
  if (!resolvedStorage) return { ok: false, reason: 'unavailable' };
  const envelope = parseEnvelope(resolvedStorage.getItem(SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY));
  const remaining = envelope.entries.filter((entry) => entry.tabId !== normalizedTabId);
  const entries: StoredDraft[] = [
    { tabId: normalizedTabId, draft: normalizedDraft, updatedAt: Date.now() },
    ...remaining,
  ].slice(0, MAX_ENTRIES);
  while (entries.length > 1) {
    const bytes = byteLength(JSON.stringify({ version: STORAGE_VERSION, entries }));
    if (bytes <= MAX_SCRIPT_DRAFT_TOTAL_BYTES) break;
    entries.pop();
  }
  return writeEnvelope(resolvedStorage, { version: STORAGE_VERSION, entries });
};

export const clearScriptWorkbenchDraft = (
  tabId: string,
  storage?: ScriptWorkbenchDraftStorage,
): boolean => {
  const normalizedTabId = shortText(tabId);
  const resolvedStorage = resolveStorage(storage);
  if (!normalizedTabId || !resolvedStorage) return false;
  const envelope = parseEnvelope(resolvedStorage.getItem(SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY));
  return writeEnvelope(resolvedStorage, {
    version: STORAGE_VERSION,
    entries: envelope.entries.filter((entry) => entry.tabId !== normalizedTabId),
  }).ok;
};
