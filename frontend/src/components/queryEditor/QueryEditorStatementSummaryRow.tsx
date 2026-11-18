import React from 'react';
import { Button, Tag } from 'antd';

import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import {
    queryEditorStatementSummaryStatusLabel,
    resolveQueryEditorStatementSummaryStatus,
    type QueryEditorStatementSummaryEntry,
    type QueryEditorStatementSummaryStatus,
} from './run/queryEditorRunStatementSummary';

const TAG_COLOR: Record<QueryEditorStatementSummaryStatus, string> = {
    success: 'success',
    failed: 'error',
    skipped: 'default',
    unknown: 'warning',
    rolled_back: 'purple',
};

type QueryEditorStatementSummaryRowProps = {
    entry: QueryEditorStatementSummaryEntry;
    onViewDetails: (entry: QueryEditorStatementSummaryEntry) => void;
};

const QueryEditorStatementSummaryRow: React.FC<QueryEditorStatementSummaryRowProps> = ({ entry, onViewDetails }) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? defaultTranslate;
    const status = resolveQueryEditorStatementSummaryStatus(entry.status, entry.error);
    const detail = entry.error?.trim()
        || (status === 'success' && entry.rowCountMeaningless
            ? t('query_editor.result.schema_change_applied')
            : '');

    return (
        <tr
            className={`is-${status}`}
            data-query-result-summary-row="true"
            data-status={status}
        >
            <td className="gn-query-statement-summary-index">{entry.statementIndex}</td>
            <td>
                <Tag color={TAG_COLOR[status]}>
                    {queryEditorStatementSummaryStatusLabel(status, t)}
                </Tag>
            </td>
            <td className="gn-query-statement-summary-sql" title={entry.statement}>
                {entry.statement}
            </td>
            <td className="gn-query-statement-summary-affected">
                {entry.affectedRows === undefined ? '—' : entry.affectedRows.toLocaleString()}
            </td>
            <td className="gn-query-statement-summary-detail" data-query-result-summary-detail="true">
                <div className="gn-query-statement-summary-detail-content">
                    <span className="gn-query-statement-summary-detail-preview" title={detail || undefined}>
                        {detail || '—'}
                    </span>
                    {entry.error?.trim() ? (
                        <Button
                            size="small"
                            type="link"
                            className="gn-query-statement-summary-view-details"
                            aria-haspopup="dialog"
                            onClick={() => onViewDetails(entry)}
                        >
                            {t('query_editor.result.summary.action.view_details')}
                        </Button>
                    ) : null}
                </div>
            </td>
        </tr>
    );
};

export default QueryEditorStatementSummaryRow;
