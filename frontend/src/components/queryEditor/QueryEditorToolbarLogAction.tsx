import React from 'react';
import { Tooltip } from 'antd';
import { QueryToolbarButton } from './QueryToolbarButton';
import { BugOutlined } from '@ant-design/icons';

import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';

export type QueryEditorToolbarLogActionProps = {
  enabled: boolean;
  onToggle: () => void;
};

export const QueryEditorToolbarLogAction: React.FC<QueryEditorToolbarLogActionProps> = ({
  enabled,
  onToggle,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  // 固定文案：状态交给 aria-pressed 表达，避免与「隐藏/显示结果区」等按钮的匹配混淆。
  const title = t(enabled
    ? 'query_editor.action.hide_sql_execution_log'
    : 'query_editor.action.show_sql_execution_log');

  return (
    <Tooltip title={title}>
      <QueryToolbarButton
        aria-label={t('log_panel.title')}
        aria-pressed={enabled}
        className="gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-log-action"
        type={enabled ? 'primary' : 'default'}
        icon={<BugOutlined />}
        onClick={onToggle}
      />
    </Tooltip>
  );
};
