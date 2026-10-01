import { t } from '../../i18n';

// 本地导入与批量安装共用的纯判定/文案辅助。
// 原本内联在 DriverManagerModal 里，抽出以便安装编排 hook 复用。

export type DriverInstallPolicyRow = {
  reasonCode?: string;
  packageInstalled: boolean;
};

export type DriverLocalSourceCode = 'file' | 'directory';

/** 精简构建下缺该驱动，且没有已装包：此类行不能走本地安装，需提示用户换完整版。 */
export const isSlimBuildInstallUnavailable = (row: DriverInstallPolicyRow) => (
  row.reasonCode === 'slim_build_missing_driver' && !row.packageInstalled
);

export const resolveDriverLocalSourceLabel = (sourceLabel: DriverLocalSourceCode) => (
  sourceLabel === 'directory' ? t('driver.modal.localSource.directory') : t('driver.modal.localSource.file')
);

export const formatDriverBatchSkipSummary = (dedupeSkipCount: number, slimSkipCount: number) => {
  const skipParts: string[] = [];
  if (dedupeSkipCount > 0) {
    skipParts.push(t('driver.modal.batch.skip.dedupe', { count: dedupeSkipCount }));
  }
  if (slimSkipCount > 0) {
    skipParts.push(t('driver.modal.batch.skip.slim', { count: slimSkipCount }));
  }
  return skipParts.length > 0
    ? t('driver.modal.batch.skip.summary', { summary: skipParts.join(t('driver.modal.punctuation.comma')) })
    : '';
};

export const formatDriverVersionTip = (version: string) => (
  version ? t('driver.modal.version.tip', { version }) : ''
);

export const formatDriverLogVersionTip = (version: string) => (
  version ? t('driver.modal.operationLog.versionTip', { version }) : ''
);
