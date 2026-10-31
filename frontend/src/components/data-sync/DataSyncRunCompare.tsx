import { useMemo, useState } from 'react';
import { tableHasCompareDiff } from './compareRepairSql';
import { DataSyncCompareAppendixTable } from './DataSyncCompareAppendixTable';
import { DataSyncCompareDetailTable } from './DataSyncCompareDetailTable';
import { DataSyncCompareFilters, type CompareGroupBy } from './DataSyncCompareFilters';
import { DataSyncCompareSummary } from './DataSyncCompareSummary';
import { RunEventTimeline } from './DataSyncRunEventTimeline';
import {
  filterDetailRows,
  filterDetailRowsByRisk,
  groupByKind,
  groupByTable,
  projectCompareDetailRows,
  splitByDetailGroup,
} from './dataSyncCompareDetailModel';
import type {
  CompareRiskBucket,
  CompareTableFilter,
} from './dataSyncCompareSummaryModel';
import type { DataSyncCompareResult } from './model';
import {
  buildCompareSummary,
  filterCompareTables,
} from './dataSyncCompareSummaryModel';
import type {
  CompareHtmlExportOutcome,
  DataSyncRunHistoryProps,
} from './dataSyncRunHistoryTypes';

type ExportNotice = { tone: 'ok' | 'error'; text: string; path?: string } | null;

export function DataSyncRunCompare(props: DataSyncRunHistoryProps) {
  const { selectedRunId, runEvents, compareResult, compareMode, t, onGenerateRepairSql, onAskAiAboutDiffs, onSyncDiffs, onExportCompareHtml, onOpenExportedFile } = props;
  const isCompareWorkbench = props.family === 'compare';
  const compareDetailOpen = isCompareWorkbench && Boolean(selectedRunId);
  // 筛选只影响明细列表；KPI 与分布始终按完整结果统计，避免筛选后指标跳变。
  const [filter, setFilter] = useState<CompareTableFilter>('all');
  const [query, setQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState<CompareRiskBucket[]>([]);
  const [groupBy, setGroupBy] = useState<CompareGroupBy>('table');
  const [detailTab, setDetailTab] = useState<'main' | 'appendix'>('main');
  // 导出结果就地反馈：成功给出落盘路径，取消保持静默。
  const [exportNotice, setExportNotice] = useState<ExportNotice>(null);
  const onExportPathClick = (path: string) => {
    if (!onOpenExportedFile || !path) return;
    void onOpenExportedFile(path).then((opened) => {
      // 打开失败时退回导出提示，让用户知道系统没能打开这个文件。
      if (!opened) {
        setExportNotice((current) => current && {
          ...current,
          tone: 'error',
          text: t('compare.export.open_failed'),
        });
      }
    });
  };
  const runExport = async (action: () => Promise<CompareHtmlExportOutcome>) => {
    const outcome = await action();
    if (outcome.kind === 'saved') {
      setExportNotice({
        tone: 'ok',
        // 路径单独成链接：文本里不再重复拼一次，避免出现两份路径。
        text: t('compare.export.success_short'),
        path: outcome.path,
      });
    } else if (outcome.kind === 'failed') {
      setExportNotice({
        tone: 'error',
        text: t('compare.export.failed', { error: outcome.error }),
      });
    }
  };
  const effectiveMode = compareResult?.content || compareMode;
  const summary = useMemo(
    () => buildCompareSummary(compareResult, compareMode),
    [compareResult, compareMode],
  );
  // 明细改走「每条变更一行」的投影：只有摊平后才有变更类型列与按类型分组。
  // 标签页仍按表状态筛，先在表级过滤，再投影，避免把整表状态拆散。
  const visibleTables = useMemo(
    () => filterCompareTables(
      compareResult?.tables || [],
      effectiveMode,
      filter,
      '',
      [],
      t,
    ),
    [compareResult, effectiveMode, filter, t],
  );
  const detailRows = useMemo(() => {
    const projected = projectCompareDetailRows(
      { ...(compareResult as DataSyncCompareResult), tables: visibleTables },
      effectiveMode,
    );
    const searched = filterDetailRows(projected, query, t);
    const risked = filterDetailRowsByRisk(searched, riskFilter);
    return groupBy === 'kind' ? groupByKind(risked) : groupByTable(risked);
  }, [compareResult, visibleTables, effectiveMode, query, riskFilter, groupBy, t]);
  const detailGroups = useMemo(
    () => (groupBy === 'kind' ? splitByDetailGroup(detailRows) : null),
    [detailRows, groupBy],
  );
  const detailCount = detailRows.length;
  // 附表只有存在默认值/注释差异时才作为可切换页签出现。
  const hasAppendix = (compareResult?.tables || []).some(
    (row) => (row.attributeDiffs || []).length > 0,
  );
  return <>
    {(!isCompareWorkbench && compareResult) || compareDetailOpen ? (
      <section className="gn-data-sync-compare-panel" data-data-sync-compare="true">
        <h2>{t('compare.title')}</h2>
        {isCompareWorkbench &&
          compareResult &&
          (onExportCompareHtml || compareResult.tables.some((row) =>
            tableHasCompareDiff(row, compareResult.content || compareMode),
          )) ? (
          <div className="gn-data-sync-compare-toolbar">
            {onGenerateRepairSql ? (
              <button
                type="button"
                className="gn-data-sync-button"
                data-compare-action="repair-sql"
                onClick={onGenerateRepairSql}
              >
                {t('compare.actions.repair_sql')}
              </button>
            ) : null}
            {onAskAiAboutDiffs ? (
              <button
                type="button"
                className="gn-data-sync-button"
                data-compare-action="ai-sql"
                onClick={onAskAiAboutDiffs}
              >
                {t('compare.actions.ai_sql')}
              </button>
            ) : null}
            {onSyncDiffs ? (
              <button
                type="button"
                className="gn-data-sync-button gn-data-sync-button--primary"
                data-compare-action="sync-diff"
                onClick={onSyncDiffs}
              >
                {t('compare.actions.sync_diff')}
              </button>
            ) : null}
            {onExportCompareHtml ? (
              <button
                type="button"
                className="gn-data-sync-button"
                data-compare-action="export-html"
                onClick={() => void runExport(onExportCompareHtml)}
              >
                {t('compare.actions.export_html')}
              </button>
            ) : null}
          </div>
        ) : null}
        {exportNotice ? (
          <p
            className="gn-data-sync-inline-note"
            data-tone={exportNotice.tone}
            data-data-sync-compare-export-notice={exportNotice.tone}
            role={exportNotice.tone === 'error' ? 'alert' : 'status'}
          >
            {exportNotice.text}
            {exportNotice.path ? (
              <>
                {' '}
                <button
                  type="button"
                  className="gn-data-sync-link-button gn-data-sync-compare-export-path"
                  data-compare-export-path={exportNotice.path}
                  title={exportNotice.path}
                  onClick={() => onExportPathClick(exportNotice.path!)}
                >
                  {exportNotice.path}
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {isCompareWorkbench ? (
          <details className="gn-data-sync-run-events gn-data-sync-run-events--secondary" data-data-sync-run-events="true">
            <summary>{t('events.title_secondary')}</summary>
            {runEvents.length === 0 ? (
              <p>{t('events.empty')}</p>
            ) : (
              <RunEventTimeline key={selectedRunId} events={runEvents.filter((event) => event.runId === selectedRunId)} t={t} history={props} />
            )}
          </details>
        ) : null}
        {!selectedRunId || !compareResult ? (
          <p>{t('compare.empty')}</p>
        ) : compareResult.tables.length === 0 ? (
          <p>{compareResult.message || t('compare.empty')}</p>
        ) : (
          <>
            <DataSyncCompareSummary summary={summary} result={compareResult} t={t} />
            <DataSyncCompareFilters
              summary={summary}
              filter={filter}
              query={query}
              riskFilter={riskFilter}
              visibleCount={detailCount}
              groupBy={groupBy}
              onFilterChange={setFilter}
              onQueryChange={setQuery}
              onRiskFilterChange={setRiskFilter}
              onGroupByChange={setGroupBy}
              t={t}
            />
            {hasAppendix ? (
              <div className="gn-data-sync-compare-detail-tabs" role="tablist">
                {(['main', 'appendix'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    className="gn-data-sync-compare-detail-tab"
                    data-detail-tab={key}
                    aria-selected={detailTab === key}
                    onClick={() => setDetailTab(key)}
                  >
                    {t(key === 'main'
                      ? 'compare.appendix.tab_main'
                      : 'compare.appendix.tab_appendix')}
                  </button>
                ))}
              </div>
            ) : null}
            {detailTab === 'appendix' && hasAppendix ? (
              <DataSyncCompareAppendixTable result={compareResult} t={t} />
            ) : detailRows.length === 0 ? (
              <p className="gn-data-sync-compare-empty-filter" data-data-sync-compare-empty-filter="true">
                {t('compare.filters.empty')}
              </p>
            ) : (
              <DataSyncCompareDetailTable
                rows={detailRows}
                groups={groupBy === 'kind' ? detailGroups : null}
                groupBy={groupBy}
                t={t}
              />
            )}
          </>
        )}
      </section>
    ) : null}
  </>;
}
