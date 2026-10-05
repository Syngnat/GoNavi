import { resolveDataSyncWorkbenchLocale } from './textLocale';
export { resolveDataSyncWorkbenchLocale } from './textLocale';
export type { DataSyncWorkbenchLocale } from './textLocale';
import { backupTexts } from './textBackup';
import { type DataSyncWorkbenchTextKey, zhCN } from './textZhCN';
import { enUS } from './textEnUS';
export type { DataSyncWorkbenchTextKey } from './textZhCN';

/**
 * Literal keys owned by the Data Sync workbench's feature-local catalog.
 * Exported so the repository-wide i18n scanner can validate these calls
 * against the same catalog contract instead of treating them as global keys.
 */
export const DATA_SYNC_WORKBENCH_TEXT_KEYS: readonly DataSyncWorkbenchTextKey[] =
  Object.freeze(Object.keys(zhCN) as DataSyncWorkbenchTextKey[]);

export type DataSyncWorkbenchTranslate = (
  key: DataSyncWorkbenchTextKey,
  params?: Record<string, string | number>,
) => string;

export { dataSyncTaskKindTextKey, dataSyncTaskKindChoiceTextKey, dataSyncStageTextKey } from './textTaskKeys';

export const createDataSyncWorkbenchTranslate = (
  language?: string,
): DataSyncWorkbenchTranslate => {
  const catalog = { ...(resolveDataSyncWorkbenchLocale(language) === 'zh-CN' ? zhCN : enUS), ...backupTexts(language || 'en-US') };
  return (key, params) => {
    let value = catalog[key] || key;
    Object.entries(params || {}).forEach(([name, replacement]) => {
      value = value.split(`{${name}}`).join(String(replacement));
    });
    return value;
  };
};

/**
 * Stable validation codes are the localization contract; the rendering rules
 * live in `textValidationIssue.ts` so this catalog keeps to copy only.
 */
export { dataSyncValidationIssueText } from './textValidationIssue';
