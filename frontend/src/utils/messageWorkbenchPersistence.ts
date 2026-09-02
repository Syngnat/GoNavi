import type { MessageConsumeDraft } from './messageConsume';
import type { MessagePublishDraft, MessagePublishValueMode } from './messagePublish';

export const MESSAGE_WORKBENCH_STORAGE_KEY = 'gonavi-message-workbench-v1';
export const MESSAGE_WORKBENCH_SCHEMA_VERSION = 1 as const;

const MAX_SCOPES = 32;
const MAX_SUBSCRIPTIONS_PER_SCOPE = 100;
const MAX_SCOPE_PART_LENGTH = 512;
const MAX_SUBSCRIPTION_ID_LENGTH = 256;
const MAX_DESTINATION_LENGTH = 65_535;
const MAX_SHORT_VALUE_LENGTH = 65_535;
const MAX_BODY_LENGTH = 256 * 1024;
const MAX_STRUCTURED_VALUE_LENGTH = 128 * 1024;
const DEFAULT_CONSUME_LIMIT = 100;
const MAX_CONSUME_LIMIT = 1000;

export type MessageWorkbenchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type PersistedMessageSubscription = {
  id: string;
  draft: MessageConsumeDraft;
};

type PersistedMessageWorkbenchScope = {
  connectionId: string;
  executionDbName: string;
  publishDraft?: MessagePublishDraft;
  subscriptions: PersistedMessageSubscription[];
  updatedAt: number;
};

type PersistedMessageWorkbenchEnvelope = {
  schemaVersion: typeof MESSAGE_WORKBENCH_SCHEMA_VERSION;
  scopes: PersistedMessageWorkbenchScope[];
};

type NormalizedScope = {
  connectionId: string;
  executionDbName: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const boundedString = (
  value: unknown,
  maxLength: number,
  trim = false,
): string => {
  if (typeof value !== 'string') return '';
  const text = trim ? value.trim() : value;
  return text.slice(0, maxLength);
};

const optionalBoundedString = (
  value: unknown,
  maxLength: number,
  trim = false,
): string | undefined => (
  typeof value === 'string' ? boundedString(value, maxLength, trim) : undefined
);

const normalizeMode = (value: unknown): MessagePublishValueMode | undefined => (
  value === 'text' || value === 'json' ? value : undefined
);

const normalizeScope = (
  connectionId: unknown,
  executionDbName: unknown,
): NormalizedScope | null => {
  const normalizedConnectionId = boundedString(
    connectionId,
    MAX_SCOPE_PART_LENGTH,
    true,
  );
  if (!normalizedConnectionId) return null;
  return {
    connectionId: normalizedConnectionId,
    executionDbName: boundedString(executionDbName, MAX_SCOPE_PART_LENGTH, true),
  };
};

const scopesMatch = (
  left: NormalizedScope,
  right: NormalizedScope,
): boolean => (
  left.connectionId === right.connectionId
  && left.executionDbName === right.executionDbName
);

const sanitizePublishDraft = (value: unknown): MessagePublishDraft | null => {
  if (!isRecord(value)) return null;

  const draft: MessagePublishDraft = {
    destination: boundedString(value.destination, MAX_DESTINATION_LENGTH, true),
    body: boundedString(value.body, MAX_BODY_LENGTH),
  };
  const exchange = optionalBoundedString(value.exchange, MAX_SHORT_VALUE_LENGTH, true);
  const routingKey = optionalBoundedString(value.routingKey, MAX_SHORT_VALUE_LENGTH, true);
  const tag = optionalBoundedString(value.tag, MAX_SHORT_VALUE_LENGTH, true);
  const key = optionalBoundedString(value.key, MAX_STRUCTURED_VALUE_LENGTH);
  const headers = optionalBoundedString(value.headers, MAX_STRUCTURED_VALUE_LENGTH);
  const properties = optionalBoundedString(value.properties, MAX_STRUCTURED_VALUE_LENGTH);
  const keyMode = normalizeMode(value.keyMode);
  const bodyMode = normalizeMode(value.bodyMode);
  const qos = Number(value.qos);
  const delayLevel = Number(value.delayLevel);

  if (exchange !== undefined) draft.exchange = exchange;
  if (routingKey !== undefined) draft.routingKey = routingKey;
  if (Number.isInteger(qos) && qos >= 0 && qos <= 2) draft.qos = qos;
  if (typeof value.retain === 'boolean') draft.retain = value.retain;
  if (tag !== undefined) draft.tag = tag;
  if (Number.isInteger(delayLevel) && delayLevel >= 0 && delayLevel <= 18) {
    draft.delayLevel = delayLevel;
  }
  if (keyMode) draft.keyMode = keyMode;
  if (key !== undefined) draft.key = key;
  if (bodyMode) draft.bodyMode = bodyMode;
  if (headers !== undefined) draft.headers = headers;
  if (properties !== undefined) draft.properties = properties;
  return draft;
};

const sanitizeConsumeDraft = (value: unknown): MessageConsumeDraft | null => {
  if (!isRecord(value)) return null;
  const destination = boundedString(value.destination, MAX_DESTINATION_LENGTH, true);
  if (!destination) return null;

  const rawLimit = Number(value.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_CONSUME_LIMIT
    ? rawLimit
    : DEFAULT_CONSUME_LIMIT;
  const draft: MessageConsumeDraft = { destination, limit };
  const qos = Number(value.qos);
  if (Number.isInteger(qos) && qos >= 0 && qos <= 2) draft.qos = qos;
  const consumerGroup = optionalBoundedString(
    value.consumerGroup,
    MAX_SHORT_VALUE_LENGTH,
    true,
  );
  if (consumerGroup) draft.consumerGroup = consumerGroup;
  return draft;
};

const sanitizeSubscriptions = (value: unknown): PersistedMessageSubscription[] => {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const subscriptions: PersistedMessageSubscription[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = boundedString(candidate.id, MAX_SUBSCRIPTION_ID_LENGTH, true);
    const draft = sanitizeConsumeDraft(candidate.draft);
    if (!id || !draft || seenIds.has(id)) continue;
    seenIds.add(id);
    subscriptions.push({ id, draft });
    if (subscriptions.length >= MAX_SUBSCRIPTIONS_PER_SCOPE) break;
  }
  return subscriptions;
};

const emptyEnvelope = (): PersistedMessageWorkbenchEnvelope => ({
  schemaVersion: MESSAGE_WORKBENCH_SCHEMA_VERSION,
  scopes: [],
});

const sanitizeEnvelope = (value: unknown): PersistedMessageWorkbenchEnvelope => {
  if (!isRecord(value)
    || value.schemaVersion !== MESSAGE_WORKBENCH_SCHEMA_VERSION
    || !Array.isArray(value.scopes)) {
    return emptyEnvelope();
  }

  const scopesByKey = new Map<string, PersistedMessageWorkbenchScope>();
  value.scopes.forEach((candidate) => {
    if (!isRecord(candidate)) return;
    const scope = normalizeScope(candidate.connectionId, candidate.executionDbName);
    if (!scope) return;
    const publishDraft = sanitizePublishDraft(candidate.publishDraft) || undefined;
    const subscriptions = sanitizeSubscriptions(candidate.subscriptions);
    if (!publishDraft && subscriptions.length === 0) return;
    const rawUpdatedAt = Number(candidate.updatedAt);
    const updatedAt = Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
      ? Math.trunc(rawUpdatedAt)
      : 0;
    const key = `${scope.connectionId}\u0000${scope.executionDbName}`;
    const previous = scopesByKey.get(key);
    if (previous && previous.updatedAt > updatedAt) return;
    scopesByKey.set(key, {
      ...scope,
      publishDraft,
      subscriptions,
      updatedAt,
    });
  });

  return {
    schemaVersion: MESSAGE_WORKBENCH_SCHEMA_VERSION,
    scopes: Array.from(scopesByKey.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_SCOPES),
  };
};

const resolveStorage = (storage?: MessageWorkbenchStorage): MessageWorkbenchStorage | null => {
  if (storage) return storage;
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

const readEnvelope = (storage: MessageWorkbenchStorage): PersistedMessageWorkbenchEnvelope => {
  try {
    const raw = storage.getItem(MESSAGE_WORKBENCH_STORAGE_KEY);
    return raw ? sanitizeEnvelope(JSON.parse(raw)) : emptyEnvelope();
  } catch {
    return emptyEnvelope();
  }
};

const hasUnsupportedSchema = (storage: MessageWorkbenchStorage): boolean => {
  try {
    const raw = storage.getItem(MESSAGE_WORKBENCH_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return isRecord(parsed)
      && Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion')
      && parsed.schemaVersion !== MESSAGE_WORKBENCH_SCHEMA_VERSION;
  } catch {
    // Corrupt v1 data is recoverable by writing a fresh sanitized envelope.
    return false;
  }
};

const writeEnvelope = (
  storage: MessageWorkbenchStorage,
  envelope: PersistedMessageWorkbenchEnvelope,
): boolean => {
  try {
    if (envelope.scopes.length === 0) {
      storage.removeItem(MESSAGE_WORKBENCH_STORAGE_KEY);
    } else {
      storage.setItem(MESSAGE_WORKBENCH_STORAGE_KEY, JSON.stringify(envelope));
    }
    return true;
  } catch {
    return false;
  }
};

const loadScope = (
  connectionId: string,
  executionDbName: string,
  storage?: MessageWorkbenchStorage,
): PersistedMessageWorkbenchScope | null => {
  const scope = normalizeScope(connectionId, executionDbName);
  const resolvedStorage = resolveStorage(storage);
  if (!scope || !resolvedStorage) return null;
  return readEnvelope(resolvedStorage).scopes.find((candidate) => (
    scopesMatch(candidate, scope)
  )) || null;
};

const updateScope = (
  connectionId: string,
  executionDbName: string,
  storage: MessageWorkbenchStorage | undefined,
  update: (current: PersistedMessageWorkbenchScope | null) => PersistedMessageWorkbenchScope | null,
): boolean => {
  const scope = normalizeScope(connectionId, executionDbName);
  const resolvedStorage = resolveStorage(storage);
  if (!scope || !resolvedStorage) return false;
  // Never let an older client destroy data written by a newer schema. Reads
  // remain empty for compatibility, while writes fail explicitly so the UI can
  // tell the user that this version cannot persist the draft.
  if (hasUnsupportedSchema(resolvedStorage)) return false;

  const envelope = readEnvelope(resolvedStorage);
  const currentIndex = envelope.scopes.findIndex((candidate) => scopesMatch(candidate, scope));
  const current = currentIndex >= 0 ? envelope.scopes[currentIndex] : null;
  const next = update(current);
  const remaining = envelope.scopes.filter((_, index) => index !== currentIndex);
  if (next) remaining.unshift(next);
  envelope.scopes = remaining
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SCOPES);
  return writeEnvelope(resolvedStorage, envelope);
};

export const loadMessageSubscriptions = (
  connectionId: string,
  executionDbName: string,
  storage?: MessageWorkbenchStorage,
): PersistedMessageSubscription[] => (
  loadScope(connectionId, executionDbName, storage)?.subscriptions || []
);

export const saveMessageSubscriptions = (
  connectionId: string,
  executionDbName: string,
  subscriptions: readonly PersistedMessageSubscription[],
  storage?: MessageWorkbenchStorage,
): boolean => {
  const normalized = sanitizeSubscriptions(subscriptions);
  return updateScope(connectionId, executionDbName, storage, (current) => {
    if (normalized.length === 0 && !current?.publishDraft) return null;
    return {
      connectionId: boundedString(connectionId, MAX_SCOPE_PART_LENGTH, true),
      executionDbName: boundedString(executionDbName, MAX_SCOPE_PART_LENGTH, true),
      publishDraft: current?.publishDraft,
      subscriptions: normalized,
      updatedAt: Date.now(),
    };
  });
};

export const loadMessagePublishDraft = (
  connectionId: string,
  executionDbName: string,
  storage?: MessageWorkbenchStorage,
): MessagePublishDraft | null => (
  loadScope(connectionId, executionDbName, storage)?.publishDraft || null
);

export const saveMessagePublishDraft = (
  connectionId: string,
  executionDbName: string,
  draft: MessagePublishDraft,
  storage?: MessageWorkbenchStorage,
): boolean => {
  const normalized = sanitizePublishDraft(draft);
  if (!normalized) return false;
  return updateScope(connectionId, executionDbName, storage, (current) => ({
    connectionId: boundedString(connectionId, MAX_SCOPE_PART_LENGTH, true),
    executionDbName: boundedString(executionDbName, MAX_SCOPE_PART_LENGTH, true),
    publishDraft: normalized,
    subscriptions: current?.subscriptions || [],
    updatedAt: Date.now(),
  }));
};

export const clearMessageWorkbenchScope = (
  connectionId: string,
  executionDbName: string,
  storage?: MessageWorkbenchStorage,
): boolean => updateScope(connectionId, executionDbName, storage, () => null);
