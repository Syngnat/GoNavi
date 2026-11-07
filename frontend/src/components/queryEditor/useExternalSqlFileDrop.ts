import { useEffect } from 'react';
import { message } from 'antd';

import { t } from '../../i18n';
import { useStore } from '../../store';
import { getSQLFileTabDraft } from '../../utils/sqlFileTabDrafts';
import { ReadSQLFile } from '../../../wailsjs/go/app/App';
import { OnFileDrop } from '../../../wailsjs/runtime';
import {
  formatRejectedSqlDropNames,
  openDroppedSqlFiles,
  partitionSqlDropPaths,
  sortSqlDropPaths,
  type ExternalSqlFileDropContext,
  type ExternalSqlFileDropDeps,
} from './externalSqlFileDrop';

// Wails 的 OnFileDrop 只允许注册一次（后续调用被运行时静默跳过），而查询
// 编辑器会随标签页多实例挂载，因此用模块级标记保证整个窗口只注册一个
// 回调。注册后不再注销：Wails 的 window 级监听会拦截所有外部文件拖放的
// 默认行为，即使当前没有查询编辑器，也不让 WebView 因拖入文件而导航
// 离开应用；回调内全部状态在事件发生时从 store 读取，不存在闭包过期。
let sharedDropRegistered = false;

export const buildExternalSqlDropDeps = (): ExternalSqlFileDropDeps => ({
  readSqlFile: ReadSQLFile,
  getSnapshot: () => {
    const state = useStore.getState();
    return {
      tabs: state.tabs,
      externalSQLDirectories: state.externalSQLDirectories,
    };
  },
  getSQLFileTabDraft,
  addTab: (tab) => useStore.getState().addTab(tab),
  setActiveTab: (tabId) => useStore.getState().setActiveTab(tabId),
  notify: (level, text) => {
    message[level](text);
  },
  translate: (key, params) => t(key, params),
});

export const resolveExternalSqlDropContext = (): ExternalSqlFileDropContext => {
  const state = useStore.getState();
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  return {
    connectionId: String(activeTab?.connectionId || '').trim(),
    dbName: String(activeTab?.dbName || '').trim(),
  };
};

const handleExternalSqlFileDrop = (
  _x: number,
  _y: number,
  paths: string[],
): void => {
  const { sqlFiles, rejectedPaths } = partitionSqlDropPaths(paths);
  if (rejectedPaths.length > 0) {
    message.warning(t('query_editor.message.external_sql_drop_rejected_files', {
      count: rejectedPaths.length,
      names: formatRejectedSqlDropNames(rejectedPaths),
    }));
  }
  if (sqlFiles.length === 0) return;
  void openDroppedSqlFiles(
    buildExternalSqlDropDeps(),
    sortSqlDropPaths(sqlFiles),
    resolveExternalSqlDropContext(),
  );
};

const isWailsFileDropRuntimeAvailable = (): boolean => {
  if (typeof window === 'undefined') return false;
  const runtime = (window as { runtime?: { OnFileDrop?: unknown } }).runtime;
  return typeof runtime?.OnFileDrop === 'function';
};

export const useExternalSqlFileDrop = (): void => {
  useEffect(() => {
    if (sharedDropRegistered || !isWailsFileDropRuntimeAvailable()) return;
    // useDropTarget=true：只有拖到带 --wails-drop-target 样式的元素上才回调
    //（样式挂在 QueryEditor 的 Monaco stage 上，见 App.css）。
    OnFileDrop(handleExternalSqlFileDrop, true);
    sharedDropRegistered = true;
  }, []);
};
