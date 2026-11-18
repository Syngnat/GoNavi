import React from 'react';
import { Button, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

import Modal from '../common/ResizableDraggableModal';
import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import { APP_FOREGROUND_MODAL_Z_INDEX } from '../../utils/overlayZIndex';
import type { QueryEditorStatementSummaryEntry } from './run/queryEditorRunStatementSummary';
import './QueryEditorStatementErrorDetailsModal.css';

type QueryEditorStatementErrorDetailsModalProps = {
    entry: QueryEditorStatementSummaryEntry;
    darkMode: boolean;
    onClose: () => void;
};

const QueryEditorStatementErrorDetailsModal: React.FC<QueryEditorStatementErrorDetailsModalProps> = ({
    entry,
    darkMode,
    onClose,
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? defaultTranslate;
    const handleCopy = async (text: string) => {
        try {
            if (typeof navigator?.clipboard?.writeText !== 'function') {
                throw new Error(t('query_editor.results_panel.message.copy_unsupported'));
            }
            await navigator.clipboard.writeText(text);
            message.success(t('data_grid.message.copied_to_clipboard'));
        } catch (error: unknown) {
            message.error(t('query_editor.results_panel.message.copy_failed', {
                detail: error instanceof Error ? error.message : t('common.unknown'),
            }));
        }
    };

    return (
        <Modal
            open
            centered
            width={880}
            zIndex={APP_FOREGROUND_MODAL_Z_INDEX}
            title={t('query_editor.result.summary.details.title', { index: entry.statementIndex })}
            onCancel={onClose}
            styles={{ body: { maxHeight: '65vh', minHeight: 0, overflow: 'auto' } }}
            footer={[
                <Button key="copy-error" icon={<CopyOutlined />} onClick={() => { void handleCopy(entry.error || ''); }}>
                    {t('query_editor.result.summary.action.copy_error')}
                </Button>,
                <Button key="copy-sql" icon={<CopyOutlined />} onClick={() => { void handleCopy(entry.statement); }}>
                    {t('query_editor.result.summary.action.copy_sql')}
                </Button>,
                <Button key="close" onClick={onClose}>{t('common.close')}</Button>,
            ]}
        >
            <div className="gn-query-statement-error-details" data-dark={darkMode ? 'true' : 'false'}>
                <section>
                    <h3>{t('query_editor.result.summary.columns.sql')}</h3>
                    <pre data-query-result-error-sql="true">{entry.statement}</pre>
                </section>
                <section>
                    <h3>{t('query_editor.result.summary.details.error')}</h3>
                    <pre className="gn-query-statement-error-message" data-query-result-error-message="true">
                        {entry.error}
                    </pre>
                </section>
            </div>
        </Modal>
    );
};

export default QueryEditorStatementErrorDetailsModal;
