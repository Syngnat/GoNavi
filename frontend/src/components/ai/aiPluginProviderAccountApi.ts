import { PluginInvoke } from '../../../wailsjs/go/app/App';

export type AccountState = 'ready' | 'signed_out';

export interface AccountStatus {
  state: AccountState;
  reason: string;
  email: string;
  userId: string;
  balance?: number;
  frozenBalance?: number;
  totalRecharged?: number;
  concurrency?: number;
  status: string;
  expiresAt: string;
}

export interface AccountKeyItem {
  id: string;
  name: string;
  key: string;
  status: string;
  groupId?: string;
  groupName: string;
  rateMultiplier?: number;
  quota?: number;
  quotaUsed?: number;
  lastUsedAt: string;
}

export interface AccountGroupItem {
  id: string;
  name: string;
  rateMultiplier?: number;
}

export interface AccountPoll {
  state: 'pending' | 'ready';
}

// Unsupported means the plugin does not expose this account command at all.
export type AccountOutcome<T> =
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; data: T };

type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord | null =>
  value !== null && typeof value === 'object' ? (value as RawRecord) : null;

// The host copies the plugin payload into QueryResult.Data, which may arrive
// as a parsed object or as raw JSON text depending on the plugin transport.
const readEnvelope = (value: unknown): RawRecord | null => {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const parseErrorText = (envelope: RawRecord | null, message: unknown): string => {
  const error = asRecord(envelope?.error);
  return asText(error?.message) || asText(message);
};

export const parseAccountStatus = (raw: unknown): AccountStatus | null => {
  const data = asRecord(raw);
  if (!data) return null;
  const state = data.state === 'ready' ? 'ready' : data.state === 'signed_out' ? 'signed_out' : null;
  if (!state) return null;
  return {
    state,
    reason: asText(data.reason),
    email: asText(data.email),
    userId: asText(data.userId),
    balance: asNumber(data.balance),
    frozenBalance: asNumber(data.frozenBalance),
    totalRecharged: asNumber(data.totalRecharged),
    concurrency: asNumber(data.concurrency),
    status: asText(data.status),
    expiresAt: asText(data.expiresAt),
  };
};

export const parseAccountPoll = (raw: unknown): AccountPoll | null => {
  const data = asRecord(raw);
  if (!data) return null;
  const state = data.state === 'ready' ? 'ready' : data.state === 'pending' ? 'pending' : null;
  return state ? { state } : null;
};

export const parseAccountStarted = (raw: unknown): { started: boolean } | null => {
  const data = asRecord(raw);
  return data ? { started: data.started === true } : null;
};

const asID = (value: unknown): string =>
  asText(value) || (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');

const parseKeyItem = (raw: unknown): AccountKeyItem | null => {
  const item = asRecord(raw);
  if (!item) return null;
  return {
    id: asID(item.id),
    name: asText(item.name),
    key: asText(item.key),
    status: asText(item.status),
    groupId: asID(item.groupId),
    groupName: asText(item.groupName),
    rateMultiplier: asNumber(item.rateMultiplier),
    quota: asNumber(item.quota),
    quotaUsed: asNumber(item.quotaUsed),
    lastUsedAt: asText(item.lastUsedAt),
  };
};

export const parseAccountKeys = (raw: unknown): AccountKeyItem[] | null => {
  const data = asRecord(raw);
  const items = data?.items;
  if (!Array.isArray(items)) return null;
  return items.map(parseKeyItem).filter((item): item is AccountKeyItem => item !== null);
};

export const parseAccountGroups = (raw: unknown): AccountGroupItem[] | null => {
  const data = asRecord(raw);
  const items = data?.items;
  if (!Array.isArray(items)) return null;
  const parsed: AccountGroupItem[] = [];
  for (const item of items) {
    const row = asRecord(item);
    if (!row) continue;
    const id = asID(row.id);
    if (!id) continue;
    parsed.push({ id, name: asText(row.name), rateMultiplier: asNumber(row.rateMultiplier) });
  }
  return parsed;
};

export const parseCreatedAccountKey = (raw: unknown): AccountKeyItem | null => parseKeyItem(raw);

// 网关扫描到的一个模型：id 必需；name / contextWindow 是网关自己给的元数据，
// 网关没给时留空，由 models.dev 公共目录补齐。
export interface ScannedModelItem {
  id: string;
  name: string;
  contextWindow: number;
  /** 网关按密钥分组返回：同一模型可能只被部分密钥收录。 */
  keyIds: string[];
}

export const parseScanAccountModels = (raw: unknown): ScannedModelItem[] | null => {
  const data = asRecord(raw);
  const items = data?.items;
  if (!Array.isArray(items)) return null;
  const scanned: ScannedModelItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const row = asRecord(item);
    const id = asText(row?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const context = asNumber(row?.contextWindow) ?? 0;
    const keyIds = Array.isArray(row?.keyIds) ? row.keyIds.map((value) => asID(value)).filter(Boolean) : [];
    scanned.push({ id, name: asText(row?.name), contextWindow: context > 0 ? context : 0, keyIds });
  }
  return scanned;
};

export const parseAccountKeyID = (raw: unknown): string | null => {
  const id = asID(asRecord(raw)?.id);
  return id || null;
};

export async function invokeAccountCommand<T>(
  pluginId: string,
  command: string,
  parse: (raw: unknown) => T | null,
  payload: Record<string, unknown> = {},
): Promise<AccountOutcome<T>> {
  let result: unknown;
  try {
    result = await PluginInvoke(pluginId, command, JSON.stringify(payload));
  } catch {
    return { kind: 'error', message: '' };
  }
  const query = asRecord(result);
  if (!query || query.success !== true) return { kind: 'unsupported' };
  const envelope = readEnvelope(query.data);
  if (!envelope || envelope.ok !== true) {
    return { kind: 'error', message: parseErrorText(envelope, query.message) };
  }
  const data = parse(envelope.data);
  return data === null ? { kind: 'error', message: '' } : { kind: 'ok', data };
}

// Trim trailing zeros so 63.6900001 renders as 63.69 and 100 as 100.
export const formatAccountAmount = (value: number | undefined): string => {
  if (value === undefined) return '-';
  const fixed = Math.round(value * 100) / 100;
  return String(fixed);
};

export const maskAccountKey = (key: string): string => {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  const prefix = trimmed.startsWith('sk-') ? 'sk-' : trimmed.slice(0, 3);
  return `${prefix}****${trimmed.slice(-4)}`;
};

export const accountGroupTone = (name: string): number => {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) sum += name.charCodeAt(i);
  return sum % 4;
};

export const accountGroupLabel = (
  name: string,
  rate: number | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string => {
  if (!name) return '';
  if (rate === undefined) return name;
  return t('plugin.ai_provider.account.group_multiplier', { group: name, rate });
};

export const formatAccountTime = (value: string): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
