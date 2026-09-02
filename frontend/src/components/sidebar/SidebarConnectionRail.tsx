import React from 'react';
import { Tooltip } from 'antd';
import {
  FolderOpenOutlined,
  TableOutlined,
  DatabaseOutlined,
  ImportOutlined,
  FileAddOutlined,
  AimOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';

// V2 Connection Rail 子组件（从 Sidebar.tsx 抽取）。
//
// 注意：本组件是 Sidebar.tsx 拆分的一部分，依赖大量主组件的 label/state/handler。
// 通过聚合 props 对象传递，避免 18+ 个独立 props 的 drilling 噪音。
// 后续状态管理重构（PR-A）会把 labels/handlers 迁到 useSidebarUIState hook。
//
// 设计取舍：用 labels + handlers 聚合对象和可选工作台入口，换取 Sidebar.tsx 减少 props drilling。
// 主组件 props drilling 复杂度可控（只有一处调用点）。

export interface SidebarConnectionRailProps {
  labels: {
    railSystemActions: string;
    railObjectActions: string;
    newGroup: string;
    batchTables: string;
    batchDatabases: string;
    dataImport: string;
    openExternalSqlFile: string;
    locateCurrentTable: string;
    locateCurrentTableUnavailable: string;
    aiAssistant: string;
    settings: string;
  };
  handlers: {
    openCreateTagModal: () => void;
    openBatchTableExport: () => void;
    openBatchDatabaseExport: () => void;
    openDataImport: () => void;
    openExternalSqlFile: () => void;
    locateActiveTab: () => void;
    toggleAI: () => void;
    openSettings: () => void;
  };
  canLocateActiveTab: boolean;
  /** General object actions are rendered in the title bar for the V2 layout. */
  showObjectActions?: boolean;
  /** The current-table locator can move to the expanded sidebar title bar. */
  showLocateAction?: boolean;
  /** Workbench actions can be moved to a wider host when the rail is compact. */
  showWorkbenchActions?: boolean;
  /** Whether the docked AI assistant is currently visible. */
  aiActive?: boolean;
  sidebarExpandAction?: {
    label: string;
    onClick: () => void;
    buttonRef?: React.Ref<HTMLButtonElement>;
  };
  workbenchActions?: React.ReactNode;
}

const SidebarConnectionRail: React.FC<SidebarConnectionRailProps> = ({
  labels,
  handlers,
  canLocateActiveTab,
  showObjectActions = true,
  showLocateAction = true,
  showWorkbenchActions = true,
  aiActive = false,
  sidebarExpandAction,
  workbenchActions,
}) => (
  <div className="gn-v2-connection-rail" data-sidebar-fixed-rail="true" aria-label={labels.railSystemActions}>
    <div className="gn-v2-rail-items">
      <div className="gn-v2-rail-primary-actions" aria-label={labels.railObjectActions}>
        {sidebarExpandAction && (
          <div className="gn-v2-rail-sidebar-toggle-slot">
            <Tooltip title={sidebarExpandAction.label} placement="right" mouseEnterDelay={0.35}>
              <button
                ref={sidebarExpandAction.buttonRef}
                type="button"
                className="gn-v2-rail-tool gn-v2-rail-sidebar-toggle"
                data-sidebar-collapse-trigger="true"
                data-sidebar-toggle-placement="fixed-rail"
                aria-label={sidebarExpandAction.label}
                aria-controls="gonavi-sidebar-tree-panel"
                aria-expanded={false}
                onClick={sidebarExpandAction.onClick}
              >
                <MenuUnfoldOutlined />
              </button>
            </Tooltip>
          </div>
        )}
        {showObjectActions && (
          <>
            <Tooltip title={labels.newGroup} placement="right">
              <button
                type="button"
                className="gn-v2-rail-tool gn-v2-rail-action"
                onClick={handlers.openCreateTagModal}
                aria-label={labels.newGroup}
                data-sidebar-create-group-action="true"
              >
                <FolderOpenOutlined />
              </button>
            </Tooltip>
            <Tooltip title={labels.batchTables} placement="right">
              <button
                type="button"
                className="gn-v2-rail-tool gn-v2-rail-action"
                onClick={handlers.openBatchTableExport}
                aria-label={labels.batchTables}
                data-sidebar-batch-table-action="true"
              >
                <TableOutlined />
              </button>
            </Tooltip>
            <Tooltip title={labels.batchDatabases} placement="right">
              <button
                type="button"
                className="gn-v2-rail-tool gn-v2-rail-action"
                onClick={handlers.openBatchDatabaseExport}
                aria-label={labels.batchDatabases}
                data-sidebar-batch-database-action="true"
              >
                <DatabaseOutlined />
              </button>
            </Tooltip>
            <Tooltip title={labels.dataImport} placement="right">
              <button
                type="button"
                className="gn-v2-rail-tool gn-v2-rail-action"
                onClick={handlers.openDataImport}
                aria-label={labels.dataImport}
                data-sidebar-data-import-action="true"
              >
                <ImportOutlined />
              </button>
            </Tooltip>
            <Tooltip title={labels.openExternalSqlFile} placement="right">
              <button
                type="button"
                className="gn-v2-rail-tool gn-v2-rail-action"
                onClick={handlers.openExternalSqlFile}
                aria-label={labels.openExternalSqlFile}
                data-sidebar-open-external-sql-file-action="true"
              >
                <FileAddOutlined />
              </button>
            </Tooltip>
          </>
        )}
        {showLocateAction && (
          <Tooltip title={canLocateActiveTab ? labels.locateCurrentTable : labels.locateCurrentTableUnavailable} placement="right">
            <span className="gn-v2-rail-action-wrap">
              <button
                type="button"
                className="gn-v2-rail-tool gn-v2-rail-action"
                onClick={handlers.locateActiveTab}
                aria-label={labels.locateCurrentTable}
                data-sidebar-locate-current-tab-action="true"
                disabled={!canLocateActiveTab}
              >
                <AimOutlined />
              </button>
            </span>
          </Tooltip>
        )}
      </div>
    </div>
    <div className="gn-v2-rail-secondary-actions" aria-label={labels.railSystemActions}>
      {showWorkbenchActions && workbenchActions && (
        <div className="gn-v2-rail-workbench-actions">
          {workbenchActions}
        </div>
      )}
      <div className="gn-v2-rail-system-actions">
        <Tooltip title={labels.aiAssistant} placement="right">
          <button
            type="button"
            className={`gn-v2-rail-tool${aiActive ? ' is-active' : ''}`}
            onClick={handlers.toggleAI}
            aria-label={labels.aiAssistant}
            aria-pressed={aiActive}
            data-gonavi-ai-entry-action="true"
          >
            <RobotOutlined />
          </button>
        </Tooltip>
        <Tooltip title={labels.settings} placement="right">
          <button type="button" className="gn-v2-rail-tool" onClick={handlers.openSettings} aria-label={labels.settings}>
            <SettingOutlined />
          </button>
        </Tooltip>
      </div>
    </div>
  </div>
);

export default SidebarConnectionRail;
