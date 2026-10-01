import React from 'react';
import type { MenuProps } from 'antd';
import { ClockCircleOutlined, HistoryOutlined, SearchOutlined } from '@ant-design/icons';
import type { I18nKey } from '../../i18n/catalog';
import {
  getShortcutDisplayLabel,
  type ShortcutPlatform,
  type ShortcutPlatformBinding,
} from '../../utils/shortcuts';

export type QueryEditorAnalysisMenuOptions = {
  translate: (key: I18nKey) => string;
  activeShortcutPlatform: ShortcutPlatform;
  diagnoseQueryShortcutBinding?: ShortcutPlatformBinding;
  showSlowQueriesShortcutBinding?: ShortcutPlatformBinding;
  supportsExplainDiagnosis: boolean;
  onOpenQueryHistory: () => void;
  onDiagnoseQuery: () => void;
  onOpenSlowQueries: () => void;
};

const renderTitleWithShortcut = (
  title: string,
  binding: ShortcutPlatformBinding | undefined,
  platform: ShortcutPlatform,
): React.ReactNode => (
  <span className="gn-v2-context-menu-item-title">
    {title}
    {binding?.enabled && binding.combo && (
      <span className="gn-v2-context-menu-kbd">
        {getShortcutDisplayLabel(binding.combo, platform)}
      </span>
    )}
  </span>
);

/** 工具栏「历史与诊断」入口的菜单项：执行历史 / SQL 诊断 / 慢 SQL 历史。 */
export const buildQueryEditorAnalysisMenuItems = ({
  translate,
  activeShortcutPlatform,
  diagnoseQueryShortcutBinding,
  showSlowQueriesShortcutBinding,
  supportsExplainDiagnosis,
  onOpenQueryHistory,
  onDiagnoseQuery,
  onOpenSlowQueries,
}: QueryEditorAnalysisMenuOptions): MenuProps['items'] => [
  {
    key: 'show-query-history',
    icon: <ClockCircleOutlined />,
    label: translate('query_history.action.open'),
    onClick: onOpenQueryHistory,
  },
  {
    key: 'diagnose-query',
    icon: <SearchOutlined />,
    label: renderTitleWithShortcut(
      translate('app.shortcuts.action.diagnoseQuery.label'),
      diagnoseQueryShortcutBinding,
      activeShortcutPlatform,
    ),
    disabled: !supportsExplainDiagnosis,
    onClick: onDiagnoseQuery,
  },
  {
    key: 'show-slow-queries',
    icon: <HistoryOutlined />,
    label: renderTitleWithShortcut(
      translate('app.shortcuts.action.showSlowQueries.label'),
      showSlowQueriesShortcutBinding,
      activeShortcutPlatform,
    ),
    onClick: onOpenSlowQueries,
  },
];
