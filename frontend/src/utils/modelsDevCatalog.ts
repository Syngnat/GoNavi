// models.dev 公共目录在前端的读法。
//
// 目录本身（下载、缓存的存储、按 ID / 短名 / canonical 建索引）由 Go 侧的
// internal/ai/modelsdev 负责，绑定 AIResolveModelCatalog 把结果交给前端；
// 这里只做解码、展示标签拼接与档位换算，内置供应商与插件供应商共用同一套规则。

export interface ModelCatalogEntry {
  id: string;
  name: string;
  contextWindow: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const normalize = (value: string): string => value.trim().toLowerCase();

// 绑定返回的整包：只有 success 与 entries 是必需项，目录不可用时 entries 为空。
export interface ModelCatalogResponse {
  available: boolean;
  stale: boolean;
  entries: ModelCatalogEntry[];
  error: string;
}

export function decodeModelCatalogResponse(raw: unknown): ModelCatalogResponse {
  const record = asRecord(raw);
  const entries: ModelCatalogEntry[] = [];
  const items = record?.entries;
  if (Array.isArray(items)) {
    for (const item of items) {
      const entry = asRecord(item);
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) continue;
      const context = typeof entry?.contextWindow === 'number' && Number.isFinite(entry.contextWindow) ? entry.contextWindow : 0;
      entries.push({ id, name: typeof entry?.name === 'string' ? entry.name.trim() : '', contextWindow: context > 0 ? context : 0 });
    }
  }
  return {
    available: record?.available === true,
    stale: record?.stale === true,
    entries,
    error: typeof record?.error === 'string' ? record.error : '',
  };
}

// 索引键覆盖 ID 本身与末段：网关常写 "anthropic/claude-sonnet-4-5"，
// 目录里记的是 "claude-sonnet-4-5"。既没有名称也没有窗口的条目不进索引，
// 它们是「目录里查不到」的占位，只用来避免重复请求。
export function indexModelCatalog(entries: readonly ModelCatalogEntry[]): Map<string, ModelCatalogEntry> {
  const index = new Map<string, ModelCatalogEntry>();
  for (const entry of entries) {
    if (!entry.name && !entry.contextWindow) continue;
    const id = normalize(entry.id);
    if (!id) continue;
    if (!index.has(id)) index.set(id, entry);
    const tail = id.split('/').pop();
    if (tail && tail !== id && !index.has(tail)) index.set(tail, entry);
  }
  return index;
}

export function modelCatalogEntryFor(index: Map<string, ModelCatalogEntry> | undefined, id: string): ModelCatalogEntry | undefined {
  const key = normalize(id);
  if (!key || !index || index.size === 0) return undefined;
  return index.get(key) ?? index.get(key.split('/').pop() || '');
}

export function modelCatalogNameFor(index: Map<string, ModelCatalogEntry> | undefined, id: string): string {
  return modelCatalogEntryFor(index, id)?.name ?? '';
}

export function modelCatalogWindowFor(index: Map<string, ModelCatalogEntry> | undefined, id: string): number {
  return modelCatalogEntryFor(index, id)?.contextWindow ?? 0;
}

// 档位表：买家口径的整数档（1M / 500K / 256K…），1024 进制的裸值折算到最近一档。
const CONTEXT_TIERS = [2_000_000, 1_500_000, 1_000_000, 500_000, 256_000, 200_000, 128_000, 64_000, 32_000];
const TIER_TOLERANCE = 0.06;

export const snapContextTier = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  let best = Math.round(value);
  let bestGap = TIER_TOLERANCE;
  for (const tier of CONTEXT_TIERS) {
    const gap = Math.abs(value - tier) / tier;
    if (gap <= bestGap) {
      bestGap = gap;
      best = tier;
    }
  }
  return best;
};

// 始终按档位渲染：1000000 → 1M，500000 → 500K，128000 → 128K。
export const formatContextTier = (value: number | undefined): string => {
  if (!value || !Number.isFinite(value) || value <= 0) return '';
  const tier = snapContextTier(value);
  if (tier >= 1_000_000) return `${Math.round((tier / 1_000_000) * 10) / 10}M`;
  if (tier >= 1000) return `${Math.round((tier / 1000) * 10) / 10}K`;
  return String(tier);
};

// 接受 1M、1.5m、500K、128k 或 1000000 这样的纯数字。
export const parseContextTier = (text: string): number | null => {
  const raw = text.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  if (!raw) return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)([mk])?$/.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  const value = unit === 'm' ? amount * 1_000_000 : unit === 'k' ? amount * 1000 : amount;
  if (!Number.isFinite(value) || value < 1024 || value > 8_000_000) return null;
  return Math.round(value);
};

// 候选档位：模型自己声明的窗口优先，目录不认识时给常用档，保证总能选一个。
export function contextTierOptions(index: Map<string, ModelCatalogEntry> | undefined, modelIds: readonly string[]): number[] {
  const found = new Set<number>();
  for (const id of modelIds) {
    const window = modelCatalogWindowFor(index, id);
    if (window) found.add(snapContextTier(window));
  }
  const ordered = [...found].sort((left, right) => right - left);
  return ordered.length ? ordered : [1_000_000, 500_000, 256_000, 200_000, 128_000];
}

// 展示标签：目录命中时是「名称 · 窗口」，否则退回原始 ID。
export function modelCatalogLabelFor(index: Map<string, ModelCatalogEntry> | undefined, id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  const entry = modelCatalogEntryFor(index, trimmed);
  if (!entry) return trimmed;
  const window = formatContextTier(entry.contextWindow);
  const name = entry.name || trimmed;
  return window ? `${name} · ${window}` : name;
}

// 选项标签统一走目录：value 仍然是原始 ID，存进配置的也是原始 ID。
export function applyModelCatalogLabels<T extends { value: string; label: string }>(
  options: readonly T[],
  index: Map<string, ModelCatalogEntry> | undefined,
): T[] {
  if (!index || index.size === 0) return options as T[];
  return options.map((option) => {
    const label = modelCatalogLabelFor(index, option.value);
    return label && label !== option.label ? { ...option, label } : option;
  });
}
