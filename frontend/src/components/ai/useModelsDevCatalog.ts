import { useEffect, useMemo, useRef, useState } from 'react';
import { AIResolveModelCatalog } from '../../../wailsjs/go/aiservice/Service';
import {
  decodeModelCatalogResponse,
  indexModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
} from '../../utils/modelsDevCatalog';

export interface ModelsDevCatalogState {
  /** ID（含末段写法）到目录条目的索引。 */
  index: Map<string, ModelCatalogEntry>;
  /** 目录是否真的拿到了；false 时只显示原始 ID。 */
  available: boolean;
}

type CatalogLoader = (models: string[]) => Promise<ModelCatalogResponse>;

// 进程内累积：同一个模型 ID 只问一次 Go，多个编辑器共用答案。
const entriesById = new Map<string, ModelCatalogEntry>();
let catalogAvailable = false;
let pending: Promise<void> | null = null;

const loadFromBinding: CatalogLoader = async (models) => {
  try {
    return decodeModelCatalogResponse(await AIResolveModelCatalog([...models]));
  } catch {
    // 绑定不可用（例如独立窗口尚未就绪）只是少一层命名增强，模型区照常可用。
    return { available: false, stale: false, entries: [], error: '' };
  }
};

let loadCatalog: CatalogLoader = loadFromBinding;

/** 测试注入用的替换点；不传参数时恢复走绑定。 */
export const setModelCatalogLoaderForTests = (loader?: CatalogLoader) => {
  loadCatalog = loader ?? loadFromBinding;
  entriesById.clear();
  catalogAvailable = false;
  pending = null;
};

const snapshot = (): ModelsDevCatalogState => ({
  index: indexModelCatalog([...entriesById.values()]),
  available: catalogAvailable,
});

const unknownIds = (models: readonly string[]): string[] => {
  const missing: string[] = [];
  for (const model of models) {
    const id = model.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (entriesById.has(key) || missing.includes(id)) continue;
    missing.push(id);
  }
  return missing;
};

// 一次只跑一批请求：多个编辑器同时挂载时共享同一次往返。
const requestEntries = async (models: readonly string[]): Promise<void> => {
  const missing = unknownIds(models);
  if (missing.length === 0) return;
  if (!pending) {
    pending = loadCatalog(missing).then((response) => {
      catalogAvailable = catalogAvailable || response.available;
      for (const entry of response.entries) entriesById.set(entry.id.trim().toLowerCase(), entry);
      // 目录里没有的 ID 也记下来，否则每次渲染都会为同一批未知模型重新请求。
      for (const id of missing) {
        const key = id.toLowerCase();
        if (!entriesById.has(key)) entriesById.set(key, { id, name: '', contextWindow: 0 });
      }
    }).finally(() => { pending = null; });
  }
  const waitFor = pending;
  try {
    await waitFor;
  } catch {
    // 上一批失败不该拖住这一批：清掉未命中的占位，下次重新问。
    for (const id of unknownIds(models)) entriesById.delete(id.toLowerCase());
  }
};

/**
 * 用 models.dev 公共目录补全模型 ID 的展示名称与上下文窗口。
 *
 * 目录来自 Go 侧（AIResolveModelCatalog），结果在进程内按 ID 累积复用；
 * id 集合变化只补问新增的 ID，已问过的（包括目录里没有的）不再往返。
 */
export function useModelsDevCatalog(models: readonly string[]): ModelsDevCatalogState {
  const [state, setState] = useState<ModelsDevCatalogState>(snapshot);
  const ids = useMemo(() => models.filter((model) => typeof model === 'string' && model.trim() !== ''), [models]);
  const idsKey = ids.join('\u0000');
  const requestRef = useRef(0);
  useEffect(() => {
    const request = ++requestRef.current;
    void requestEntries(ids).then(() => {
      if (request !== requestRef.current) return;
      setState(snapshot());
    });
    // 只有 ID 集合变化才重新问：数组字面量每次渲染都是新引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  return state;
}
