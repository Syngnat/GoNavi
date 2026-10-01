/**
 * 预检问题的本地化渲染。
 *
 * 从 `text.ts` 抽出：那个目录文件已超出行数上限，而这里的规则还在增长
 * （超时要带上「已检查几张、卡在哪张」）。类型走 `import type`，编译后不产生
 * 运行时依赖，所以 `text.ts` 反向 re-export 不会构成循环导入。
 */
import type { DataSyncWorkbenchTextKey, DataSyncWorkbenchTranslate } from './text';

/**
 * Stable validation codes are the localization contract. The codes below are
 * categories whose actionable cause exists only in the backend message, so the
 * diagnostic is appended instead of dropped:
 * - CDC probing is environment-specific (replica-set setup, binlog privileges,
 *   publication state).
 * - `definition_invalid` wraps every backend ValidateDefinition failure (Cron
 *   field count, unsupported enum, batch range), so the localized sentence
 *   alone leaves the user unable to locate the fault.
 */
const BACKEND_DIAGNOSTIC_ISSUE_CODES = new Set([
  'definition_invalid',
  'cdc_probe_failed',
  'cdc_adapter_not_ready',
]);

type PreflightIssueTextInput = {
  code: string;
  message?: string;
  detail?: {
    preflightProgress?: {
      checked: number;
      total: number;
      mappingLabel?: string;
    };
  };
};

/**
 * 超时文案带上映射校验进度。
 *
 * 后端只说「超时」时，用户无法区分任务太大与源端真卡住；把已检查数与卡住的那张表
 * 拼进句子里，前者可以自行拆任务，后者值得让 DBA 去看源端。
 */
const preflightTimeoutText = (
  key: DataSyncWorkbenchTextKey,
  issue: PreflightIssueTextInput,
  t: DataSyncWorkbenchTranslate,
): string | null => {
  const progress = issue.detail?.preflightProgress;
  if (!progress) return null;
  const mapping = String(progress.mappingLabel || '').trim();
  return t(key, {
    checked: progress.checked,
    total: progress.total,
    stuck: mapping ? t('validation.preflight_timeout_stuck', { mapping }) : '',
  });
};

export const dataSyncValidationIssueText = (
  issue: PreflightIssueTextInput,
  t: DataSyncWorkbenchTranslate,
): string => {
  const key = `validation.${issue.code}` as DataSyncWorkbenchTextKey;
  const localized = t(key);
  if (localized !== key) {
    if (issue.code === 'preflight_timeout') {
      const detail = preflightTimeoutText(key, issue, t);
      if (detail !== null) return detail;
    }
    if (
      BACKEND_DIAGNOSTIC_ISSUE_CODES.has(issue.code) &&
      String(issue.message || '').trim()
    ) {
      return `${localized} ${String(issue.message).trim()}`;
    }
    return localized;
  }
  return String(issue.message || '').trim() || t('validation.unknown');
};
