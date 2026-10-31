import { useMemo } from 'react';
import { applyModelCatalogLabels } from '../../../utils/modelsDevCatalog';
import { useModelsDevCatalog } from '../../ai/useModelsDevCatalog';

/**
 * 内置供应商的模型候选统一补上 models.dev 的名称与上下文档位。
 *
 * value 仍是写进配置的原始 ID，只有下拉与管理列表的 label 变可读，
 * 与插件供应商编辑器共用同一份目录（Go 侧的 AIResolveModelCatalog）。
 */
export function useProviderModelCatalogLabels(options: Array<{ value: string; label: string }>) {
  const ids = useMemo(() => options.map((option) => option.value), [options]);
  const catalog = useModelsDevCatalog(ids);
  return useMemo(() => applyModelCatalogLabels(options, catalog.index), [options, catalog.index]);
}
