import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATA_SYNC_WORKBENCH_TEXT_KEYS } from '../components/data-sync/text';
import { PLUGIN_STATE_KEYS } from '../plugins/stateKeys';
import { PLUGIN_MARKET_AUTH_KEYS } from '../pluginMarket/authKeys';
import { PLUGIN_MARKET_CATEGORY_TEXT_KEYS } from '../pluginMarket/catalogFilters';
import { PLUGIN_MARKET_VERSION_REASON_TEXT_KEYS } from '../pluginMarket/versionsApi';
import { PLUGIN_DATASOURCE_STATUS_KEYS } from '../plugins/dataSource/presentation';
import { PLUGIN_EXPORT_ERROR_KEYS } from '../plugins/exporter/result';
import { messages as legacyMessages } from '../../../shared/i18n/messages';

/**
 * 全局不变式：源码中 t('字面量') 引用的每个 key，都必须能经所属翻译器得到译文。
 *
 * 全局翻译器的解析链复刻自 src/i18n/index.ts 的 t()：
 *   toCatalogKey 前缀映射 → shared/i18n/<locale>.json → legacyTranslate(shared/i18n/messages.ts)
 * 具有独立翻译器的功能目录必须在 LOCAL_CATALOGS 注册，并仅由对应局部词典解析；
 * 这样既不会把局部 key 误报为全局缺失，也不会因碰巧存在同名全局 key 而掩盖局部拼写错误。
 * 任一环节命中即视为可解析；全部落空时会原样返回 key，
 * 用户界面上会直接显示形如 "common.retry" 的字面量。
 *
 * 本用例取代了此前散落在上百个组件测试中的「某 key 在各语言包存在」断言：
 * 那些断言只覆盖有人恰好想到的 key，本用例覆盖全部引用点且不会随重构失效。
 * 语言包之间的 key 集合一致性由 shared/i18n/catalog_test.go 的 TestCatalogKeysMatch 保证。
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const frontendSrc = `${repoRoot}frontend/src`;

type LocalCatalog = {
  sourceDirectory: string;
  keys: ReadonlySet<string>;
};

const LOCAL_CATALOGS: readonly LocalCatalog[] = [
  {
    sourceDirectory: `${frontendSrc}/components/data-sync/`,
    keys: new Set(DATA_SYNC_WORKBENCH_TEXT_KEYS),
  },
];

// 位于局部词典目录、但实际使用全局翻译器（shared/i18n）的文件，按全局链解析。
const GLOBAL_TRANSLATOR_FILES: ReadonlySet<string> = new Set([
  `${frontendSrc}/components/data-sync/DataSyncBackgroundNotice.tsx`,
  `${frontendSrc}/components/data-sync/compareRepairSql.ts`,
]);

/**
 * 动态拼接的 key（形如 t('prefix.' + value)）无法被字面量扫描覆盖。
 * 每个前缀必须在下面登记完整变体，逐个走同一条解析链；未登记的前缀仍按字面量报错。
 */
const DYNAMIC_KEY_SETS: readonly { prefix: string; keys: readonly string[] }[] = [
  { prefix: 'plugin.state.', keys: PLUGIN_STATE_KEYS },
  { prefix: 'plugin.market.auth_', keys: PLUGIN_MARKET_AUTH_KEYS },
  { prefix: 'plugin.market.category.', keys: PLUGIN_MARKET_CATEGORY_TEXT_KEYS },
  { prefix: 'plugin.market.versions.', keys: PLUGIN_MARKET_VERSION_REASON_TEXT_KEYS },
  { prefix: 'plugin.datasource.status.', keys: PLUGIN_DATASOURCE_STATUS_KEYS },
  { prefix: 'plugin_export.error.', keys: PLUGIN_EXPORT_ERROR_KEYS },
];

const localCatalogFor = (file: string): LocalCatalog | undefined =>
  GLOBAL_TRANSLATOR_FILES.has(file)
    ? undefined
    : LOCAL_CATALOGS.find((catalog) => file.startsWith(catalog.sourceDirectory));

// 与 src/i18n/index.ts 的 toCatalogKey 保持一致
const ACTION_ALIASES: Record<string, string> = {
  'common.action.cancel': 'common.cancel',
  'common.action.close': 'common.close',
  'common.action.confirm': 'common.confirm',
  'common.action.continue': 'common.continue',
  'common.action.delete': 'common.delete',
  'common.action.save': 'common.save',
};

const toCatalogKey = (key: string): string => {
  if (ACTION_ALIASES[key]) return ACTION_ALIASES[key];
  if (key.startsWith('connection.modal.')) {
    return `connection_modal.${key.slice('connection.modal.'.length)}`;
  }
  if (key.startsWith('driver.manager.')) {
    return `driver_manager.${key.slice('driver.manager.'.length)}`;
  }
  return key;
};

const collectRuntimeSources = (directory: string): string[] => readdirSync(directory)
  .flatMap((entry) => {
    const absolutePath = `${directory}/${entry}`;
    if (statSync(absolutePath).isDirectory()) {
      return /^(?:node_modules|dist)$/.test(entry) ? [] : collectRuntimeSources(absolutePath);
    }
    if (!/\.(?:ts|tsx)$/.test(entry) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry)) {
      return [];
    }
    return [absolutePath];
  });

describe('i18n key resolution', () => {
  it('resolves every literal t() key through the catalog or legacy fallback', () => {
    const catalogKeys = new Set(Object.keys(
      JSON.parse(readFileSync(`${repoRoot}shared/i18n/zh-CN.json`, 'utf8')) as Record<string, string>,
    ));
    const legacyKeys = new Set(Object.values(legacyMessages).flatMap((catalog) => Object.keys(catalog)));

    const unresolved: string[] = [];
    let scanned = 0;
    for (const file of collectRuntimeSources(frontendSrc)) {
      const source = readFileSync(file, 'utf8');
      const localCatalog = localCatalogFor(file);
      for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
        const key = match[1];
        scanned += 1;
        const dynamic = DYNAMIC_KEY_SETS.find((entry) => entry.prefix === key);
        if (dynamic) {
          for (const variant of dynamic.keys) {
            const mapped = toCatalogKey(variant);
            if (!catalogKeys.has(mapped) && !legacyKeys.has(variant) && !legacyKeys.has(mapped)) {
              unresolved.push(`${variant} (via ${dynamic.prefix})`);
            }
          }
          continue;
        }
        if (localCatalog) {
          if (!localCatalog.keys.has(key)) {
            unresolved.push(`${key} (${file.slice(repoRoot.length)})`);
          }
          continue;
        }
        const mapped = toCatalogKey(key);
        if (catalogKeys.has(mapped) || legacyKeys.has(key) || legacyKeys.has(mapped)) continue;
        unresolved.push(`${key} (${file.slice(repoRoot.length)})`);
      }
    }

    // 下限断言：扫描器若因目录结构或正则失效而扫不到东西，本用例必须报错而不是静默通过
    expect(scanned).toBeGreaterThan(3000);
    expect(catalogKeys.size).toBeGreaterThan(8000);
    expect(DATA_SYNC_WORKBENCH_TEXT_KEYS.length).toBeGreaterThan(250);
    expect(unresolved).toEqual([]);
  });
});
