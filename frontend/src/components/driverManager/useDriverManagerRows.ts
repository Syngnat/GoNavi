import { useMemo } from 'react';
import { normalizeDriverSearchText, formatDriverCardStatusMessage } from './driverManagerMessages';
import { t } from '../../i18n';
import { isDriverReinstallTarget } from './driverOptionalUpdate';
import { type DriverStatusRow, compareDriverRows } from './driverManagerModel';
import type { DriverManagerStateApi } from './useDriverManagerState';

export interface UseDriverManagerRowsInput {
  searchKeyword: DriverManagerStateApi['searchKeyword'];
  rows: DriverManagerStateApi['rows'];
  optionalUpdateDismissedRevisions: DriverManagerStateApi['optionalUpdateDismissedRevisions'];
  driverFilter: DriverManagerStateApi['driverFilter'];
  driverSortKey: DriverManagerStateApi['driverSortKey'];
  selectedDriverType: DriverManagerStateApi['selectedDriverType'];
  loading: DriverManagerStateApi['loading'];
  batchProgress: DriverManagerStateApi['batchProgress'];
  progressMap: DriverManagerStateApi['progressMap'];
  batchAction: DriverManagerStateApi['batchAction'];
}

export const useDriverManagerRows = ({
  searchKeyword,
  rows,
  optionalUpdateDismissedRevisions,
  driverFilter,
  driverSortKey,
  selectedDriverType,
  loading,
  batchProgress,
  progressMap,
  batchAction,
}: UseDriverManagerRowsInput) => {
  const normalizedSearchKeyword = useMemo(() => normalizeDriverSearchText(searchKeyword), [searchKeyword]);
  const filteredRows = useMemo(() => {
    if (!normalizedSearchKeyword) {
      return rows;
    }
    return rows.filter((row) => {
      const searchableParts = [
        row.name,
        row.type,
        row.pinnedVersion,
        row.installedVersion,
        formatDriverCardStatusMessage(row, optionalUpdateDismissedRevisions),
        row.builtIn ? t('driver.modal.search.builtIn') : t('driver.modal.search.external'),
        isDriverReinstallTarget(row, optionalUpdateDismissedRevisions)
          ? t('driver.modal.search.reinstallRecommended')
          : row.connectable
            ? t('driver.modal.card.enabled')
            : row.packageInstalled
              ? t('driver.modal.card.installed')
              : t('driver.modal.card.notEnabled'),
      ];
      const searchableText = normalizeDriverSearchText(searchableParts.filter(Boolean).join(' '));
      return searchableText.includes(normalizedSearchKeyword);
    });
  }, [normalizedSearchKeyword, rows, optionalUpdateDismissedRevisions]);
  const visibleRows = useMemo(() => {
    let nextRows: DriverStatusRow[];
    switch (driverFilter) {
      case 'needsUpdate':
        nextRows = filteredRows.filter((row) => isDriverReinstallTarget(row, optionalUpdateDismissedRevisions));
        break;
      case 'enabled':
        nextRows = filteredRows.filter((row) => !row.builtIn && row.connectable);
        break;
      case 'notEnabled':
        // 与 statusSummary.notEnabled 同口径，否则计数与筛出的条数对不上。
        nextRows = filteredRows.filter((row) => !row.builtIn && !row.connectable);
        break;
      default:
        nextRows = filteredRows;
        break;
    }
    return [...nextRows].sort((left, right) => compareDriverRows(left, right, driverSortKey));
  }, [driverFilter, driverSortKey, filteredRows, optionalUpdateDismissedRevisions]);
  const selectedRow = useMemo(() => (
    visibleRows.find((row) => row.type === selectedDriverType) || visibleRows[0]
  ), [selectedDriverType, visibleRows]);
  const initialStatusLoading = loading && rows.length === 0;
  const statusSummary = useMemo(() => {
    const optionalRows = filteredRows.filter((row) => !row.builtIn);
    return {
      total: filteredRows.length,
      enabled: optionalRows.filter((row) => row.connectable).length,
      needsUpdate: optionalRows.filter((row) => isDriverReinstallTarget(row, optionalUpdateDismissedRevisions)).length,
      // 与 enabled 互补：此前额外的 !packageInstalled 条件会让「装了但不可用」的驱动
      // 两个计数都不进，出现「已启用 0 + 未启用 22」却对不上总数的缺口。
      notEnabled: optionalRows.filter((row) => !row.connectable).length,
    };
  }, [filteredRows, optionalUpdateDismissedRevisions]);
  const reinstallableRows = useMemo(
    () => rows.filter((row) => isDriverReinstallTarget(row, optionalUpdateDismissedRevisions)),
    [rows, optionalUpdateDismissedRevisions],
  );
  const installableRows = useMemo(
    // 已装但当前不可用（packageInstalled && !connectable）的驱动同样排除：
    // 它们需要的是「修」而不是「装」，纳入安装集会让「安装所有驱动」重复安装。
    () => rows.filter((row) => !row.builtIn && !row.connectable && !row.packageInstalled),
    [rows],
  );
  const removableRows = useMemo(
    () => rows.filter((row) => !row.builtIn && (row.connectable || row.packageInstalled)),
    [rows],
  );
  const batchProgressPercent = useMemo(() => {
    if (!batchProgress || batchProgress.total <= 0) {
      return 0;
    }
    const currentProgress = batchProgress.currentDriverType
      ? progressMap[batchProgress.currentDriverType]
      : undefined;
    const shouldUseCurrentProgress = batchAction === 'install-all' || batchAction === 'reinstall-updates';
    const currentContribution = shouldUseCurrentProgress && currentProgress && currentProgress.status !== 'error'
      ? Math.max(0, Math.min(100, Number(currentProgress.percent || 0))) / 100
      : 0;
    const completed = Math.max(0, Math.min(batchProgress.completed, batchProgress.total));
    const percent = ((completed + currentContribution) / batchProgress.total) * 100;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }, [batchAction, batchProgress, progressMap]);
  const activeBatchDriverProgress = (batchAction === 'install-all' || batchAction === 'reinstall-updates') && batchProgress?.currentDriverType
    ? progressMap[batchProgress.currentDriverType]
    : undefined;
  const batchProgressMessage = activeBatchDriverProgress?.message || batchProgress?.currentMessage || '';
  return {
    normalizedSearchKeyword,
    visibleRows,
    selectedRow,
    initialStatusLoading,
    statusSummary,
    reinstallableRows,
    installableRows,
    removableRows,
    batchProgressPercent,
    batchProgressMessage,
  };
};

export type DriverManagerRowsApi = ReturnType<typeof useDriverManagerRows>;
