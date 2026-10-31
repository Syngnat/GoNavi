import { describe, expect, it } from 'vitest';
import {
  applyModelCatalogLabels,
  contextTierOptions,
  decodeModelCatalogResponse,
  formatContextTier,
  indexModelCatalog,
  modelCatalogLabelFor,
  modelCatalogNameFor,
  modelCatalogWindowFor,
  parseContextTier,
  snapContextTier,
  type ModelCatalogEntry,
} from './modelsDevCatalog';

const entries: ModelCatalogEntry[] = [
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 262144 },
];

describe('decodeModelCatalogResponse', () => {
  it('解析绑定返回的条目并过滤畸形项', () => {
    const decoded = decodeModelCatalogResponse({
      success: true, available: true, stale: false,
      entries: [
        { id: ' a-model ', name: ' A Model ', contextWindow: 128000 },
        { id: '', name: 'no id', contextWindow: 1000 },
        { name: 'no id field', contextWindow: 1000 },
        { id: 'negative', name: 'N', contextWindow: -5 },
        'not-an-object',
      ],
    });
    expect(decoded.available).toBe(true);
    expect(decoded.entries).toEqual([
      { id: 'a-model', name: 'A Model', contextWindow: 128000 },
      { id: 'negative', name: 'N', contextWindow: 0 },
    ]);
  });

  it('目录不可用时给出空列表而不是抛错', () => {
    const decoded = decodeModelCatalogResponse({ success: false, available: false, error: '目录不可用' });
    expect(decoded.available).toBe(false);
    expect(decoded.entries).toEqual([]);
    expect(decoded.error).toBe('目录不可用');
  });

  it('非对象返回空结果', () => {
    expect(decodeModelCatalogResponse(undefined).entries).toEqual([]);
    expect(decodeModelCatalogResponse('nope').available).toBe(false);
  });
});

describe('indexModelCatalog / lookup', () => {
  it('索引同时覆盖完整 ID 与末段', () => {
    const index = indexModelCatalog(entries);
    expect(modelCatalogNameFor(index, 'anthropic/claude-sonnet-4-5')).toBe('Claude Sonnet 4.5');
    expect(modelCatalogWindowFor(index, 'CLAUDE-FABLE-5-1')).toBe(1_000_000);
  });

  it('既没有名称也没有窗口的占位条目不进索引', () => {
    const index = indexModelCatalog([{ id: 'unknown-model', name: '', contextWindow: 0 }]);
    expect(index.size).toBe(0);
    expect(modelCatalogLabelFor(index, 'unknown-model')).toBe('unknown-model');
  });

  it('目录没有的 ID 显示原始写法', () => {
    const index = indexModelCatalog(entries);
    expect(modelCatalogNameFor(index, 'gpt-9-imaginary')).toBe('');
    expect(modelCatalogWindowFor(index, 'gpt-9-imaginary')).toBe(0);
    expect(modelCatalogLabelFor(index, ' gpt-9-imaginary ')).toBe('gpt-9-imaginary');
  });
});

describe('show labels', () => {
  it('命中时是「名称 · 档位」，未命中退回原始 ID', () => {
    const index = indexModelCatalog(entries);
    expect(modelCatalogLabelFor(index, 'claude-fable-5-1')).toBe('Claude Fable 5.1 · 1M');
    expect(modelCatalogLabelFor(index, 'kimi-k3')).toBe('Kimi K3 · 256K');
    expect(modelCatalogLabelFor(index, '')).toBe('');
  });

  it('条目没有名称时用 ID 补位，没有窗口时不拼档位', () => {
    const index = indexModelCatalog([{ id: 'plain-model', name: '', contextWindow: 128000 }]);
    expect(modelCatalogLabelFor(index, 'plain-model')).toBe('plain-model · 128K');
  });

  it('选项标签保留 value，只换 label', () => {
    const index = indexModelCatalog(entries);
    const options = [{ value: 'kimi-k3', label: 'kimi-k3' }, { value: 'unknown', label: 'unknown' }];
    expect(applyModelCatalogLabels(options, index)).toEqual([
      { value: 'kimi-k3', label: 'Kimi K3 · 256K' },
      { value: 'unknown', label: 'unknown' },
    ]);
  });
});

describe('context tiers', () => {
  it('格式化按档位渲染', () => {
    expect(formatContextTier(1_000_000)).toBe('1M');
    expect(formatContextTier(1_050_000)).toBe('1M');
    expect(formatContextTier(500_000)).toBe('500K');
    expect(formatContextTier(262_144)).toBe('256K');
    expect(formatContextTier(0)).toBe('');
    expect(formatContextTier(undefined)).toBe('');
  });

  it('解析接受 1M / 500K / 纯数字', () => {
    expect(parseContextTier('1M')).toBe(1_000_000);
    expect(parseContextTier('1.5m')).toBe(1_500_000);
    expect(parseContextTier('500K')).toBe(500_000);
    expect(parseContextTier('128000')).toBe(128_000);
    expect(parseContextTier('1,000,000')).toBe(1_000_000);
    expect(parseContextTier('abc')).toBeNull();
    expect(parseContextTier('')).toBeNull();
    expect(parseContextTier('1')).toBeNull();
  });

  it('snap 把 1024 进制裸值折到最近档位', () => {
    expect(snapContextTier(1_048_576)).toBe(1_000_000);
    expect(snapContextTier(202_752)).toBe(200_000);
    expect(snapContextTier(0)).toBe(0);
  });

  it('候选项来自目录，目录为空时给常用档', () => {
    const index = indexModelCatalog(entries);
    expect(contextTierOptions(index, ['claude-fable-5-1'])).toEqual([1_000_000]);
    expect(contextTierOptions(index, ['claude-fable-5-1', 'kimi-k3'])).toEqual([1_000_000, 256_000]);
    expect(contextTierOptions(index, ['unknown'])).toEqual([1_000_000, 500_000, 256_000, 200_000, 128_000]);
  });
});
