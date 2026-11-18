import React, { useMemo, useState } from 'react';
import { Button, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import QueryEditorStatementErrorDetailsModal from './QueryEditorStatementErrorDetailsModal';
import QueryEditorStatementSummaryRow from './QueryEditorStatementSummaryRow';
import {
    buildQueryEditorStatementSummaryCopyText,
    queryEditorStatementSummaryStatusLabel,
    resolveQueryEditorStatementSummaryStatus,
    type QueryEditorStatementSummaryEntry,
    type QueryEditorStatementSummaryStatus,
} from './run/queryEditorRunStatementSummary';
import './QueryEditorStatementSummaryTable.css';

const STATUS_ORDER: QueryEditorStatementSummaryStatus[] = [
    'success',
    'failed',
    'skipped',
    'unknown',
    'rolled_back',
];

export type QueryEditorStatementSummaryTableProps = {
    title: string;
    entries: QueryEditorStatementSummaryEntry[];
    darkMode: boolean;
    fallbackText?: string;
};

const countStatuses = (entries: QueryEditorStatementSummaryEntry[]) => {
    const counts: Record<QueryEditorStatementSummaryStatus, number> = {
        success: 0,
        failed: 0,
        skipped: 0,
        unknown: 0,
        rolled_back: 0,
    };
    entries.forEach((entry) => {
        counts[resolveQueryEditorStatementSummaryStatus(entry.status, entry.error)] += 1;
    });
    return counts;
};

const QueryEditorStatementSummaryTable: React.FC<QueryEditorStatementSummaryTableProps> = ({
    title,
    entries,
    darkMode,
    fallbackText = '',
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? defaultTranslate;
    const [detailsEntry, setDetailsEntry] = useState<QueryEditorStatementSummaryEntry | null>(null);
    const counts = useMemo(() => countStatuses(entries), [entries]);
    const copyText = useMemo(
        () => (entries.length > 0
            ? buildQueryEditorStatementSummaryCopyText(entries)
            : fallbackText),
        [entries, fallbackText],
    );

    const handleCopy = async () => {
        if (!copyText.trim()) return;
        try {
            if (typeof navigator?.clipboard?.writeText !== 'function') {
                throw new Error(t('query_editor.results_panel.message.copy_unsupported'));
            }
            await navigator.clipboard.writeText(copyText);
            message.success(t('data_grid.message.copied_to_clipboard'));
        } catch (error: unknown) {
            message.error(t('query_editor.results_panel.message.copy_failed', {
                detail: error instanceof Error ? error.message : t('common.unknown'),
            }));
        }
    };

    return (
        <section
            className="gn-query-statement-summary"
            data-dark={darkMode ? 'true' : 'false'}
            data-query-result-statement-summary="true"
        >
            <header className="gn-query-statement-summary-header">
                <div className="gn-query-statement-summary-heading">
                    <span className="gn-query-statement-summary-title">{title}</span>
                    <span className="gn-query-statement-summary-total">
                        {t('query_editor.result.summary.stats.total', { count: entries.length })}
                    </span>
                    {STATUS_ORDER.map((status) => (counts[status] > 0 ? (
                        <span
                            key={status}
                            className="gn-query-statement-summary-stat"
                            data-status={status}
                        >
                            {queryEditorStatementSummaryStatusLabel(status, t)} {counts[status]}
                        </span>
                    ) : null))}
                </div>
                <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => { void handleCopy(); }}
                    disabled={!copyText.trim()}
                >
                    {t('query_editor.results_panel.message.action.copy')}
                </Button>
            </header>
            <div className="gn-query-statement-summary-scroll">
                <table
                    className="gn-query-statement-summary-table"
                    data-query-result-summary-table="true"
                >
                    <colgroup>
                        <col className="gn-query-statement-summary-col-index" />
                        <col className="gn-query-statement-summary-col-status" />
                        <col className="gn-query-statement-summary-col-sql" />
                        <col className="gn-query-statement-summary-col-affected" />
                        <col className="gn-query-statement-summary-col-detail" />
                    </colgroup>
                    <thead>
                        <tr>
                            <th>{t('query_editor.result.summary.columns.index')}</th>
                            <th>{t('query_editor.result.summary.columns.status')}</th>
                            <th>{t('query_editor.result.summary.columns.sql')}</th>
                            <th>{t('query_editor.result.summary.columns.affected_rows')}</th>
                            <th>{t('query_editor.result.summary.columns.detail')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map((entry) => (
                            <QueryEditorStatementSummaryRow
                                key={`${entry.statementIndex}-${entry.statement}`}
                                entry={entry}
                                onViewDetails={setDetailsEntry}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
            {detailsEntry && entries.includes(detailsEntry) ? (
                <QueryEditorStatementErrorDetailsModal
                    entry={detailsEntry}
                    darkMode={darkMode}
                    onClose={() => setDetailsEntry(null)}
                />
            ) : null}
        </section>
    );
};

QueryEditorStatementSummaryTable.displayName = 'QueryEditorStatementSummaryTable';

export default React.memo(QueryEditorStatementSummaryTable);
