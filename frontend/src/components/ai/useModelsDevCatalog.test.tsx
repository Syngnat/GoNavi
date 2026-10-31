import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modelCatalogLabelFor, type ModelCatalogResponse } from '../../utils/modelsDevCatalog';
import { setModelCatalogLoaderForTests, useModelsDevCatalog, type ModelsDevCatalogState } from './useModelsDevCatalog';

const response = (entries: ModelCatalogResponse['entries'], available = true): ModelCatalogResponse =>
  ({ available, stale: false, entries, error: '' });

let renderer: ReactTestRenderer | null = null;
let latest: ModelsDevCatalogState | null = null;

const Probe = ({ models }: { models: string[] }) => {
  latest = useModelsDevCatalog(models);
  return null;
};

const mount = async (models: string[]) => {
  await act(async () => {
    renderer = create(<Probe models={models} />);
  });
};

afterEach(() => {
  renderer?.unmount();
  renderer = null;
  latest = null;
  setModelCatalogLoaderForTests();
});

describe('useModelsDevCatalog', () => {
  const loader = vi.fn();

  beforeEach(() => {
    loader.mockReset();
    setModelCatalogLoaderForTests(loader);
  });

  it('把目录条目补成展示标签', async () => {
    loader.mockResolvedValue(response([{ id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000 }]));
    await mount(['claude-fable-5-1']);
    expect(loader).toHaveBeenCalledWith(['claude-fable-5-1']);
    expect(latest?.available).toBe(true);
    expect(modelCatalogLabelFor(latest?.index, 'claude-fable-5-1')).toBe('Claude Fable 5.1 · 1M');
  });

  it('同一批 ID 只问一次，跨组件复用缓存', async () => {
    loader.mockResolvedValue(response([{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 262144 }]));
    await mount(['kimi-k3']);
    await mount(['kimi-k3']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(modelCatalogLabelFor(latest?.index, 'kimi-k3')).toBe('Kimi K3 · 256K');
  });

  it('ID 集合扩大时只补问新增的 ID', async () => {
    loader.mockResolvedValue(response([{ id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000 }]));
    await mount(['claude-fable-5-1']);
    loader.mockResolvedValue(response([{ id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_000_000 }]));
    await mount(['claude-fable-5-1', 'glm-5.3']);
    expect(loader).toHaveBeenLastCalledWith(['glm-5.3']);
  });

  it('目录里没有的 ID 记住未命中，不再重复请求', async () => {
    loader.mockResolvedValue(response([]));
    await mount(['unknown-model']);
    await mount(['unknown-model']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(modelCatalogLabelFor(latest?.index, 'unknown-model')).toBe('unknown-model');
  });

  it('载荷解析失败时退回原始 ID，不抛错', async () => {
    loader.mockRejectedValue(new Error('rpc down'));
    await mount(['claude-fable-5-1']);
    expect(latest?.available).toBe(false);
    expect(modelCatalogLabelFor(latest?.index, 'claude-fable-5-1')).toBe('claude-fable-5-1');
  });

  it('绑定缺失时保持空目录', async () => {
    setModelCatalogLoaderForTests(async () => response([], false));
    await mount(['claude-fable-5-1']);
    expect(latest?.available).toBe(false);
    expect(latest?.index.size).toBe(0);
  });
});
