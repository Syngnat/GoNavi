import React from 'react';
import { FileTextOutlined, InfoCircleOutlined } from '@ant-design/icons';

import { t } from '../../i18n';
import { useStore } from '../../store';
import { useAppStatusBar } from '../hooks/useAppStatusBar';
import './appStatusBar.css';

export interface AppStatusBarProps {
  isLogPanelOpen: boolean;
  onToggleLogPanel: () => void;
}

/**
 * 底部全局状态栏（Navicat 格局）：左=活动上下文（连接 / 库 / Schema / 标签页），
 * 右=对象信息面板开关、日志开关与应用版本。高度与配色沿用 DataGrid 状态栏的 26px 契约。
 */
export const AppStatusBar = ({ isLogPanelOpen, onToggleLogPanel }: AppStatusBarProps) => {
  const { connectionName, dbName, schemaName, activeTabTitle, version } = useAppStatusBar();
  const infoPanelVisible = useStore(state => state.infoPanelVisible);
  const toggleInfoPanel = useStore(state => state.toggleInfoPanel);
  // 状态栏只属于 Navicat 布局主题；classic 保持原有无状态栏形态。
  const navicatLayout = useStore(state => state.appearance.uiLayoutMode === 'navicat');
  const contextParts = [connectionName, dbName, schemaName].filter(part => part !== '');

  if (!navicatLayout) return null;

  return (
    <div
      className="gn-app-statusbar"
      data-gonavi-statusbar="true"
      role="status"
      aria-label={t('status_bar.aria')}
    >
      <div className="gn-app-statusbar-context">
        <span className={`gn-app-statusbar-dot${contextParts.length > 0 ? ' is-on' : ''}`} aria-hidden="true" />
        {contextParts.length > 0 ? (
          <span className="gn-app-statusbar-context-text" title={contextParts.join(' / ')}>
            {contextParts.join(' / ')}
          </span>
        ) : (
          <span className="gn-app-statusbar-context-text is-placeholder">
            {t('status_bar.context.none')}
          </span>
        )}
        {activeTabTitle && (
          <>
            <span className="gn-app-statusbar-divider" aria-hidden="true" />
            <span className="gn-app-statusbar-tab" title={activeTabTitle}>{activeTabTitle}</span>
          </>
        )}
      </div>
      <div className="gn-app-statusbar-actions">
        <button
          type="button"
          className={`gn-app-statusbar-action${infoPanelVisible ? ' is-active' : ''}`}
          aria-pressed={infoPanelVisible}
          title={t('status_bar.action.object_info')}
          onClick={toggleInfoPanel}
        >
          <InfoCircleOutlined />
          <span>{t('status_bar.action.object_info')}</span>
        </button>
        <button
          type="button"
          className={`gn-app-statusbar-action${isLogPanelOpen ? ' is-active' : ''}`}
          aria-pressed={isLogPanelOpen}
          title={t('status_bar.action.logs')}
          onClick={onToggleLogPanel}
        >
          <FileTextOutlined />
          <span>{t('status_bar.action.logs')}</span>
        </button>
        {version && <span className="gn-app-statusbar-version">{version}</span>}
      </div>
    </div>
  );
};

export default AppStatusBar;
