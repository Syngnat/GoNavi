import React from 'react';
import { Button, Tooltip } from 'antd';
import { AimOutlined, CloseOutlined } from '@ant-design/icons';
import AiSparkOutlined from '../icons/AiSparkOutlined';

import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import {
    parseSqlExecutionErrorLocation,
    splitSqlErrorLocationText,
} from './queryEditorErrorLocation';

type QueryEditorExecutionErrorCardProps = {
    error: string;
    darkMode: boolean;
    compact?: boolean;
    onDiagnose?: () => void;
    diagnoseShortcutLabel?: string;
    onLocate?: () => void;
};

const QueryEditorExecutionErrorCardComponent: React.FC<QueryEditorExecutionErrorCardProps> = ({
    error,
    darkMode,
    compact = false,
    onDiagnose,
    diagnoseShortcutLabel,
    onLocate,
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? defaultTranslate;
    const location = parseSqlExecutionErrorLocation(error);
    const canLocate = Boolean(location && onLocate);
    const parts = splitSqlErrorLocationText(error, location);
    const locateLabel = location
        ? t('query_editor.result.locate_error_aria', { position: location.rawToken })
        : t('query_editor.result.locate_error');

    return (
        <div
            className="gn-query-execution-error-card"
            data-dark={darkMode ? 'true' : 'false'}
            data-compact={compact ? 'true' : 'false'}
        >
            <div className="gn-query-execution-error-title">
                <CloseOutlined />
                <span>{t('query_editor.result.execution_failed')}</span>
            </div>
            <div className="gn-query-execution-error-body custom-scrollbar">
                {parts.map((part, index) => (
                    part.locate && canLocate ? (
                        <button
                            key={`${part.text}-${index}`}
                            type="button"
                            className="gn-query-execution-error-position"
                            aria-label={locateLabel}
                            onClick={onLocate}
                        >
                            {part.text}
                        </button>
                    ) : (
                        <span key={`${part.text}-${index}`}>{part.text}</span>
                    )
                ))}
            </div>
            <div className="gn-query-execution-error-actions">
                {canLocate ? (
                    <Button icon={<AimOutlined />} onClick={onLocate}>
                        {t('query_editor.result.locate_error')}
                    </Button>
                ) : null}
                {onDiagnose ? (
                    <Tooltip
                        title={diagnoseShortcutLabel
                            ? t('query_editor.result.ai_diagnose_with_shortcut', { shortcut: diagnoseShortcutLabel })
                            : undefined}
                    >
                        <Button
                            type="primary"
                            icon={<AiSparkOutlined />}
                            className="gn-query-execution-error-diagnose"
                            onClick={onDiagnose}
                        >
                            {t('query_editor.result.ai_diagnose')}
                        </Button>
                    </Tooltip>
                ) : null}
            </div>
        </div>
    );
};

export const QueryEditorExecutionErrorCard = React.memo(QueryEditorExecutionErrorCardComponent);
