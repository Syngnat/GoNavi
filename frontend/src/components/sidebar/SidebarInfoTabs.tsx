import React, { useCallback, useRef } from 'react';
import { TableOutlined, ProfileOutlined } from '@ant-design/icons';

import { t } from '../../i18n';
import { useStore } from '../../store';
import ObjectInfoContent from '../objectInfo/ObjectInfoPanel';
import SidebarObjectQuickList from './SidebarObjectQuickList';
import './SidebarInfoTabs.css';

/**
 * 侧栏底部「对象 / 信息」双页签面板（Navicat macOS 格局）：
 * 顶部拖拽条调整高度，页签切换对象快览与选中对象的聚合信息。
 * 显隐由 store.infoPanelVisible 控制（状态栏「信息」开关）。
 */
export const SidebarInfoTabs: React.FC = () => {
  const infoPanelVisible = useStore(state => state.infoPanelVisible);
  const height = useStore(state => state.sideInfoPanelHeight);
  const activeTab = useStore(state => state.sideInfoPanelActiveTab);
  const setHeight = useStore(state => state.setSideInfoPanelHeight);
  const setActiveTab = useStore(state => state.setSideInfoPanelActiveTab);
  // 底部「对象 / 信息」面板只属于 Navicat 布局主题。
  const navicatLayout = useStore(state => state.appearance.uiLayoutMode === 'navicat');
  const resizingRef = useRef(false);

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizingRef.current = true;
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current) return;
      setHeight(startHeight + (startY - moveEvent.clientY));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [height, setHeight]);

  if (!navicatLayout || !infoPanelVisible) return null;

  return (
    <div className="gn-side-info-tabs" style={{ height }}>
      <div
        className="gn-side-info-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={handleResizeStart}
      />
      <div className="gn-side-info-tabstrip" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'objects'}
          className={`gn-side-info-tab${activeTab === 'objects' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('objects')}
        >
          <TableOutlined />
          <span>{t('sidebar.info_tabs.objects')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'info'}
          className={`gn-side-info-tab${activeTab === 'info' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          <ProfileOutlined />
          <span>{t('sidebar.info_tabs.info')}</span>
        </button>
      </div>
      <div className="gn-side-info-pane">
        {activeTab === 'objects' ? <SidebarObjectQuickList /> : <ObjectInfoContent />}
      </div>
    </div>
  );
};

export default SidebarInfoTabs;
