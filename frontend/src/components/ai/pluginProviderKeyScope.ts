import type { AccountKeyItem, ScannedModelItem } from './aiPluginProviderAccountApi';

// 已保存的密钥在表单里没有明文 apiKey，只能用尾号去账号密钥列表里对号；尾号重复时不猜。
export function resolveProviderKeyId(
  choices: readonly AccountKeyItem[],
  formKey: string,
  savedHint: string,
): string {
  const key = formKey.trim();
  if (key) return choices.find((item) => item.key === key)?.id ?? '';
  const hint = savedHint.trim().toLowerCase();
  if (hint.length !== 4) return '';
  const matches = choices.filter((item) => item.key && item.key.slice(-4).toLowerCase() === hint);
  return matches.length === 1 ? matches[0].id : '';
}

// 网关按密钥分组暴露模型：这里只保留这把密钥真正能访问到的模型。
export function modelsForKey(scanned: readonly ScannedModelItem[], keyId: string): string[] {
  if (!keyId) return [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of scanned) {
    if (!item.keyIds.includes(keyId) || seen.has(item.id)) continue;
    seen.add(item.id);
    models.push(item.id);
  }
  return models;
}

// 提示里只列有限几个模型，剩下用 +N 表示，避免一屏塞不下。
export function previewModelList(models: readonly string[], limit = 6): string {
  if (models.length === 0) return '';
  if (models.length <= limit) return models.join(' / ');
  return [...models.slice(0, limit), `+${models.length - limit}`].join(' / ');
}
