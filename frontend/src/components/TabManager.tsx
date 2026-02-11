import React, { useMemo } from 'react';
import { Tabs, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { useStore } from '../store';
import DataViewer from './DataViewer';
import QueryEditor from './QueryEditor';
import TableDesigner from './TableDesigner';
import RedisViewer from './RedisViewer';
import RedisCommandEditor from './RedisCommandEditor';
import TriggerViewer from './TriggerViewer';
import DefinitionViewer from './DefinitionViewer';
import type { TabData } from '../types';

const detectConnectionEnvLabel = (connectionName: string): string | null => {
  const tokens = connectionName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes('prod') || tokens.includes('production')) return 'PROD';
  if (tokens.includes('uat')) return 'UAT';
  if (tokens.includes('dev') || tokens.includes('development')) return 'DEV';
  if (tokens.includes('sit')) return 'SIT';
  if (tokens.includes('stg') || tokens.includes('stage') || tokens.includes('staging') || tokens.includes('pre')) return 'STG';
  if (tokens.includes('test') || tokens.includes('qa')) return 'TEST';
  return null;
};

const buildTabDisplayTitle = (tab: TabData, connectionName: string | undefined): string => {
  if (tab.type !== 'table' && tab.type !== 'design') return tab.title;
  if (!connectionName) return tab.title;
  const prefix = detectConnectionEnvLabel(connectionName) || connectionName;
  return `[${prefix}] ${tab.title}`;
};

const TabManager: React.FC = () => {
  const tabs = useStore(state => state.tabs);
  const connections = useStore(state => state.connections);
  const activeTabId = useStore(state => state.activeTabId);
  const setActiveTab = useStore(state => state.setActiveTab);
  const closeTab = useStore(state => state.closeTab);
  const closeOtherTabs = useStore(state => state.closeOtherTabs);
  const closeTabsToLeft = useStore(state => state.closeTabsToLeft);
  const closeTabsToRight = useStore(state => state.closeTabsToRight);
  const closeAllTabs = useStore(state => state.closeAllTabs);

  const onChange = (newActiveKey: string) => {
    setActiveTab(newActiveKey);
  };

  const onEdit = (targetKey: React.MouseEvent | React.KeyboardEvent | string, action: 'add' | 'remove') => {
    if (action === 'remove') {
      closeTab(targetKey as string);
    }
  };

  const items = useMemo(() => tabs.map((tab, index) => {
    const connectionName = connections.find((conn) => conn.id === tab.connectionId)?.name;
    const displayTitle = buildTabDisplayTitle(tab, connectionName);
    let content;
    if (tab.type === 'query') {
      content = <QueryEditor tab={tab} />;
    } else if (tab.type === 'table') {
      content = <DataViewer tab={tab} />;
    } else if (tab.type === 'design') {
      content = <TableDesigner tab={tab} />;
    } else if (tab.type === 'redis-keys') {
      content = <RedisViewer connectionId={tab.connectionId} redisDB={tab.redisDB ?? 0} />;
    } else if (tab.type === 'redis-command') {
      content = <RedisCommandEditor connectionId={tab.connectionId} redisDB={tab.redisDB ?? 0} />;
    } else if (tab.type === 'trigger') {
      content = <TriggerViewer tab={tab} />;
    } else if (tab.type === 'view-def' || tab.type === 'routine-def') {
      content = <DefinitionViewer tab={tab} />;
    }

    const menuItems: MenuProps['items'] = [
      {
        key: 'close-other',
        label: '关闭其他页',
        disabled: tabs.length <= 1,
        onClick: () => closeOtherTabs(tab.id),
      },
      {
        key: 'close-left',
        label: '关闭左侧',
        disabled: index === 0,
        onClick: () => closeTabsToLeft(tab.id),
      },
      {
        key: 'close-right',
        label: '关闭右侧',
        disabled: index === tabs.length - 1,
        onClick: () => closeTabsToRight(tab.id),
      },
      { type: 'divider' },
      {
        key: 'close-all',
        label: '关闭所有',
        disabled: tabs.length === 0,
        onClick: () => closeAllTabs(),
      },
    ];
    
    return {
      label: (
        <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
          <span onContextMenu={(e) => e.preventDefault()}>{displayTitle}</span>
        </Dropdown>
      ),
      key: tab.id,
      children: content,
    };
  }), [tabs, connections, closeOtherTabs, closeTabsToLeft, closeTabsToRight, closeAllTabs]);

  return (
    <>
        <style>{`
            .main-tabs {
              height: 100%;
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs .ant-tabs-nav {
              flex: 0 0 auto;
            }
            .main-tabs .ant-tabs-content-holder {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              overflow: hidden;
              display: flex;
              flex-direction: column;
            }
            .main-tabs .ant-tabs-content {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
            }
            .main-tabs .ant-tabs-tabpane {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs .ant-tabs-tabpane > div {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
            }
            .main-tabs .ant-tabs-tabpane-hidden {
              display: none !important;
            }
            .main-tabs .ant-tabs-nav::before {
                border-bottom: none !important;
            }
        `}</style>
        <Tabs
            className="main-tabs"
            type="editable-card"
            onChange={onChange}
            activeKey={activeTabId || undefined}
            onEdit={onEdit}
            items={items}
            hideAdd
        />
    </>
  );
};

export default TabManager;
