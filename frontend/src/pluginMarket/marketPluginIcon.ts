import { sourceMarketAPI } from './sourceApi';
import { githubIconCandidates } from './marketIconUrl';
import type { MarketPlugin } from './types';
import type { PluginManifest } from '../plugins/types';

interface DeclaredIcon {
  path: string;
  providerId?: string;
}

// AI 供应商插件把图标写在 contributes.aiProviders 里，与顶层 icon 同样有效。
function declaredIcon(manifest: PluginManifest | undefined): DeclaredIcon {
  const path = manifest?.icon?.trim();
  if (path) return { path };
  const provider = manifest?.contributes?.aiProviders?.find((item) => item.icon?.trim());
  return provider ? { path: provider.icon!.trim(), providerId: provider.id } : { path: '' };
}

// 未安装插件没有本机图标包，只能从市场来源的 GitHub 仓库补一次远程 Logo。
// 返回按优先级排列的候选地址；由 <img> 实际加载并逐个回退，避免冷启动时预探测误判。
export async function resolveMarketPluginIcon(plugin: MarketPlugin, sourceId: string | undefined): Promise<string[]> {
  let declared = declaredIcon(plugin.manifest);
  let sourceUrl = plugin.sourceUrl ?? '';
  let official = plugin.official;
  if ((!declared.path || !sourceUrl) && sourceId) {
    const detail = await sourceMarketAPI(sourceId).detail(plugin.id);
    if (!declared.path) declared = declaredIcon(detail.manifest);
    sourceUrl = sourceUrl || detail.sourceUrl || '';
    official = official || detail.official;
  }
  return githubIconCandidates(sourceUrl, declared.path, {
    official,
    pluginId: plugin.id,
    providerId: declared.providerId,
  });
}
