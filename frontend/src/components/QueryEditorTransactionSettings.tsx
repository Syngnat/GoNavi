import React from 'react';
import { Select, Tooltip } from 'antd';
import {
  ClockCircleOutlined,
  ControlOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';

export type SqlEditorCommitMode = 'manual' | 'auto';

type SqlEditorAutoCommitDelayOption = {
  value: number;
};

export const SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS: SqlEditorAutoCommitDelayOption[] = [
  { value: 0 },
  { value: 3000 },
  { value: 5000 },
  { value: 10000 },
  { value: 30000 },
];

type QueryEditorTransactionSettingsProps = {
  commitMode: SqlEditorCommitMode;
  autoCommitDelayMs: number;
  onCommitModeChange: (mode: SqlEditorCommitMode) => void;
  onAutoCommitDelayMsChange: (delayMs: number) => void;
};

type OpenTransactionSelect = 'mode' | 'delay' | null;

const QueryEditorTransactionSettings: React.FC<QueryEditorTransactionSettingsProps> = ({
  commitMode,
  autoCommitDelayMs,
  onCommitModeChange,
  onAutoCommitDelayMsChange,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const [openTransactionSelect, setOpenTransactionSelect] = React.useState<OpenTransactionSelect>(null);
  const updateTransactionSelectOpen = (key: Exclude<OpenTransactionSelect, null>, open: boolean) => {
    setOpenTransactionSelect((current) => open ? key : current === key ? null : current);
  };
  const autoCommitDelayOptions = SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS.map((option) => ({
    value: option.value,
    label: option.value === 0
      ? t('query_editor.transaction.delay.immediate_commit')
      : t('query_editor.transaction.delay.seconds_commit', { seconds: Math.round(option.value / 1000) }),
  }));
  const commitModeLabel = t(`query_editor.transaction.mode.${commitMode}`);
  const autoCommitDelayLabel = autoCommitDelayOptions.find(
    (option) => option.value === autoCommitDelayMs,
  )?.label ?? t('query_editor.transaction.delay.immediate_commit');
  const commitModeTooltip = `${commitModeLabel} · ${t('query_editor.transaction.mode.tooltip')}`;
  const autoCommitDelayTooltip = `${t('query_editor.transaction.mode.auto')} · ${autoCommitDelayLabel}`;

  return (
    <>
      <Tooltip
        title={openTransactionSelect === 'mode' ? null : commitModeTooltip}
        placement="topLeft"
      >
        <Select
          aria-label={commitModeLabel}
          className="gn-v2-query-toolbar-select gn-v2-query-toolbar-icon-select gn-v2-query-toolbar-transaction-mode-select"
          value={commitMode}
          popupMatchSelectWidth={false}
          onOpenChange={(open) => updateTransactionSelectOpen('mode', open)}
          onChange={(mode) => {
            setOpenTransactionSelect(null);
            onCommitModeChange(mode === 'auto' ? 'auto' : 'manual');
          }}
          labelRender={(option) => (
            <span className="gn-v2-query-toolbar-select-icon" aria-hidden="true">
              {option.value === 'auto' ? <SyncOutlined /> : <ControlOutlined />}
            </span>
          )}
          options={[
            { label: t('query_editor.transaction.mode.manual'), value: 'manual' },
            { label: t('query_editor.transaction.mode.auto'), value: 'auto' },
          ]}
        />
      </Tooltip>
      {commitMode === 'auto' && (
        <Tooltip
          title={openTransactionSelect === 'delay' ? null : autoCommitDelayTooltip}
          placement="topLeft"
        >
          <Select
            aria-label={autoCommitDelayLabel}
            className="gn-v2-query-toolbar-select gn-v2-query-toolbar-icon-select gn-v2-query-toolbar-transaction-delay-select"
            value={autoCommitDelayMs}
            popupMatchSelectWidth={false}
            onOpenChange={(open) => updateTransactionSelectOpen('delay', open)}
            onChange={(delayMs) => {
              setOpenTransactionSelect(null);
              onAutoCommitDelayMsChange(Number(delayMs));
            }}
            labelRender={() => (
              <span className="gn-v2-query-toolbar-select-icon" aria-hidden="true">
                {autoCommitDelayMs === 0 ? <ThunderboltOutlined /> : <ClockCircleOutlined />}
              </span>
            )}
            options={autoCommitDelayOptions}
          />
        </Tooltip>
      )}
    </>
  );
};

export default QueryEditorTransactionSettings;
