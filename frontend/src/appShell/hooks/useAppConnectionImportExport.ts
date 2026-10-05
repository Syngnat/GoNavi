import React, { useCallback, useRef } from 'react';
import { message } from 'antd';
import { useStore } from '../../store';
import {
  isConnectionPackagePasswordRequiredError,
  parseConnectionsExcelImportEnvelope,
  detectConnectionImportKind,
  normalizeConnectionPackagePassword,
  resolveConnectionPackageExportResult,
} from '../../utils/connectionExport';
import { normalizeConnectionPackageImportPayload } from '../connectionPackageImport';
import { resolveConnectionImportPlacement } from '../../components/settings/ConnectionImportSettingsPanel';
import { mergeRedisDbAliases } from '../../utils/redisDbAlias';
import type { ToolCenterGroupKey } from '../settingsCenterPanes';
import {
  type ExcelGroupAssignment,
  type ExcelGroupPlanContext,
  planExcelGroupAssignments,
} from '../../utils/connectionExcelGroups';
import { SavedConnection } from '../../types';
import { downloadBrowserTextFile } from '../../utils/browserFileTransfer';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppShellStateApi } from './useAppShellState';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import type { AppQuitAndUpdateApi } from './useAppQuitAndUpdate';

export interface UseAppConnectionImportExportInput {
  t: AppCoreStateApi['t'];
  connectionSidebarLayoutCoordinatorRef: AppShellStateApi['connectionSidebarLayoutCoordinatorRef'];
  connectionImportTargetTagId: AppShellStateApi['connectionImportTargetTagId'];
  setConnectionDisplaySortMode: AppSecurityUpdateApi['setConnectionDisplaySortMode'];
  refreshConnectionsAfterImport: AppQuitAndUpdateApi['refreshConnectionsAfterImport'];
  moveConnectionsToTag: AppSecurityUpdateApi['moveConnectionsToTag'];
  setConnectionImportNotice: AppShellStateApi['setConnectionImportNotice'];
  setConnectionPackageDialog: AppShellStateApi['setConnectionPackageDialog'];
  setPendingConnectionImportPayload: AppShellStateApi['setPendingConnectionImportPayload'];
  setToolCenterBackGroupKey: React.Dispatch<React.SetStateAction<ToolCenterGroupKey | null>>;
  setActiveSettingsCenterGroupKey: AppShellStateApi['setActiveSettingsCenterGroupKey'];
  setActiveSettingsCenterPane: AppShellStateApi['setActiveSettingsCenterPane'];
  browserConnectionImportSourceGroupRef: AppShellStateApi['browserConnectionImportSourceGroupRef'];
  openSettingsCenterWorkbenchTab: AppShellStateApi['openSettingsCenterWorkbenchTab'];
  isWebRuntime: AppShellStateApi['isWebRuntime'];
  browserConnectionImportInputRef: AppShellStateApi['browserConnectionImportInputRef'];
  connections: AppSecurityUpdateApi['connections'];
  connectionPackageDialog: AppShellStateApi['connectionPackageDialog'];
  pendingConnectionImportPayload: AppShellStateApi['pendingConnectionImportPayload'];
}

export const useAppConnectionImportExport = ({
  t, connectionSidebarLayoutCoordinatorRef, connectionImportTargetTagId,
  setConnectionDisplaySortMode, refreshConnectionsAfterImport, moveConnectionsToTag,
  setConnectionImportNotice, setConnectionPackageDialog, setPendingConnectionImportPayload,
  setToolCenterBackGroupKey, setActiveSettingsCenterGroupKey, setActiveSettingsCenterPane,
  browserConnectionImportSourceGroupRef, openSettingsCenterWorkbenchTab, isWebRuntime,
  browserConnectionImportInputRef, connections, connectionPackageDialog,
  pendingConnectionImportPayload,
}: UseAppConnectionImportExportInput) => {
  const importConnectionsPayload = useCallback(async (raw: string, password: string) => {
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.ImportConnectionsPayload !== 'function') {
          throw new Error(t('app.connection_package.error.import_capability_unavailable'));
      }

      await connectionSidebarLayoutCoordinatorRef.current?.bootstrap();
      const targetTagId = String(connectionImportTargetTagId || '').trim();
      if (
          targetTagId
          && !useStore.getState().connectionTags.some((tag) => tag.id === targetTagId)
      ) {
          throw new Error(t('app.connection_package.import.target_group_unavailable'));
      }

      let importedRaw: unknown;
      try {
          importedRaw = await backendApp.ImportConnectionsPayload(raw, password);
      } catch (error) {
          if (isConnectionPackagePasswordRequiredError(error)) {
              throw error;
          }
          const detail = error instanceof Error ? error.message : String(error ?? '').trim();
          throw new Error(
              detail
                  ? t('app.connection_package.message.import_failed_with_error', { error: detail })
                  : t('app.connection_package.message.import_failed'),
          );
      }
      const imported = normalizeConnectionPackageImportPayload(importedRaw);
      if (!imported) {
          throw new Error(t('app.connection_package.error.import_no_connections'));
      }
      const importedConnectionIDs = imported.connections
          .map((connection) => String(connection.id || '').trim())
          .filter(Boolean);
      const preRefreshState = useStore.getState();
      const placement = resolveConnectionImportPlacement(
          importedConnectionIDs,
          targetTagId,
          preRefreshState.connectionTags,
      );
      placement.manualOrderTargetGroupIds.forEach((groupID) => {
          setConnectionDisplaySortMode(groupID, 'manual');
      });
      await refreshConnectionsAfterImport(imported.connections);
      if (placement.groupAssignment) {
          moveConnectionsToTag(
              placement.groupAssignment.connectionIds,
              placement.groupAssignment.targetGroupId,
          );
      }
      if (placement.manualOrderTargetGroupIds.length > 0) {
          try {
              await connectionSidebarLayoutCoordinatorRef.current?.flush();
          } catch (error) {
              const detail = error instanceof Error ? error.message : String(error ?? '').trim();
              throw new Error(t('app.connection_package.import.group_save_failed', { detail }));
          }
      }
      // Redis DB 别名存在前端 appearance，需随连接包一并恢复
      if (Object.keys(imported.redisDbAliases).length > 0) {
          const currentAliases = useStore.getState().appearance.redisDbAliases;
          useStore.getState().setAppearance({
              redisDbAliases: mergeRedisDbAliases(currentAliases, imported.redisDbAliases),
          });
      }
      return imported.connections;
  }, [connectionImportTargetTagId, moveConnectionsToTag, refreshConnectionsAfterImport, setConnectionDisplaySortMode, t]);

  const importConnectionPayloadFromFile = async (raw: string, sourceGroup?: ToolCenterGroupKey) => {
      // Excel 由后端在统一入口直接完成导入，返回信封结果而非文本载荷。
      const excelResult = parseConnectionsExcelImportEnvelope(raw);
      if (excelResult) {
          await finishExcelImport({ data: excelResult }, sourceGroup);
          return;
      }

      const importKind = detectConnectionImportKind(raw);

      if (importKind === 'invalid') {
          setConnectionImportNotice(null);
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              error: t('app.connection_package.message.unsupported_file_format'),
              confirmLoading: false,
          }));
          return;
      }

      try {
          setPendingConnectionImportPayload(null);
          setConnectionImportNotice(null);
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              password: '',
              error: '',
              confirmLoading: true,
          }));
          const importedViews = await importConnectionsPayload(raw, '');
          if ((importKind === 'mysql-workbench-xml' || importKind === 'navicat-ncx') && importedViews.some(v => !v.hasPrimaryPassword)) {
              const warning = t('app.connection_package.message.imported_with_missing_passwords', { count: importedViews.length });
              setConnectionImportNotice({ type: 'warning', message: warning });
              void message.warning(warning);
          } else {
              const success = t('app.connection_package.message.imported_connections', { count: importedViews.length });
              setConnectionImportNotice({ type: 'success', message: success });
              void message.success(success);
          }
          setConnectionPackageDialog((current) => ({
              ...current,
              open: false,
              password: '',
              error: '',
              confirmLoading: false,
          }));
      } catch (e: any) {
          if (isConnectionPackagePasswordRequiredError(e)) {
              if (sourceGroup) {
                  setToolCenterBackGroupKey(sourceGroup);
                  setActiveSettingsCenterGroupKey(sourceGroup);
                  setActiveSettingsCenterPane({ key: 'import', group: sourceGroup });
              }
              setPendingConnectionImportPayload(raw);
              setConnectionPackageDialog({
                  open: true,
                  mode: 'import',
                  includeSecrets: true,
                  useFilePassword: false,
                  password: '',
                  error: '',
                  confirmLoading: false,
                  selectedConnectionIds: [],
              });
              return;
          }
          const detail = e?.message || t('app.connection_package.message.import_failed');
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              error: detail,
              confirmLoading: false,
          }));
          void message.error(detail);
      }
  };

  const handleBrowserConnectionImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const sourceGroup = browserConnectionImportSourceGroupRef.current;
      browserConnectionImportSourceGroupRef.current = undefined;
      event.target.value = '';
      if (!file) {
          return;
      }

      try {
          // Excel 为二进制格式：转 base64 走专用导入通道，其余格式按文本解析。
          if (/\.xlsx$/i.test(file.name)) {
              const backendApp = (window as any).go?.app?.App;
              if (typeof backendApp?.ImportConnectionsExcelFileBase64 !== 'function') {
                  throw new Error(t('app.connection_package.error.import_capability_unavailable'));
              }
              const dataUrl = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result || ''));
                  reader.onerror = () => reject(reader.error || new Error(t('app.connection_package.message.import_failed')));
                  reader.readAsDataURL(file);
              });
              const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
              const res = await backendApp.ImportConnectionsExcelFileBase64(base64);
              if (!res?.success) {
                  throw new Error(String(res?.message || ''));
              }
              await finishExcelImport(res, sourceGroup);
              return;
          }
          await importConnectionPayloadFromFile(await file.text(), sourceGroup);
      } catch (error) {
          const detail = error instanceof Error ? error.message : String(error ?? '').trim();
          const resolvedDetail = detail || t('app.connection_package.message.import_failed');
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              error: resolvedDetail,
              confirmLoading: false,
          }));
          void message.error(resolvedDetail);
      }
  };

  const handleImportConnections = async (sourceGroup?: ToolCenterGroupKey) => {
      setToolCenterBackGroupKey(sourceGroup ?? null);
      setConnectionImportNotice(null);
      setConnectionPackageDialog((current) => ({
          ...current,
          mode: 'import',
          password: '',
          error: '',
          confirmLoading: false,
      }));
      if (sourceGroup) {
          setActiveSettingsCenterGroupKey(sourceGroup);
          setActiveSettingsCenterPane({ key: 'import', group: sourceGroup });
          openSettingsCenterWorkbenchTab();
      }
      if (isWebRuntime) {
          const input = browserConnectionImportInputRef.current;
          if (!input) {
              void message.error(t('app.connection_package.error.import_capability_unavailable'));
              return;
          }
          browserConnectionImportSourceGroupRef.current = sourceGroup;
          input.value = '';
          input.click();
          return;
      }

      const res = await (window as any).go.app.App.ImportConfigFile();
      if (!res.success) {
          if (res.message !== "已取消") {
              const detail = t('app.connection_package.message.import_failed_with_error', { error: res.message });
              setConnectionPackageDialog((current) => ({ ...current, error: detail }));
              void message.error(detail);
          }
          return;
      }

      const raw = typeof res.data === 'string' ? res.data : String(res.data ?? '');
      await importConnectionPayloadFromFile(raw, sourceGroup);
  };

  const handleExportConnections = async (sourceGroup?: ToolCenterGroupKey) => {
      setToolCenterBackGroupKey(sourceGroup ?? null);
      if (sourceGroup) {
          setActiveSettingsCenterGroupKey(sourceGroup);
          setActiveSettingsCenterPane({ key: 'export', group: sourceGroup });
          openSettingsCenterWorkbenchTab();
      }
      setConnectionPackageDialog({
          open: true,
          mode: 'export',
          includeSecrets: true,
          useFilePassword: false,
          password: '',
          error: '',
          confirmLoading: false,
          selectedConnectionIds: connections.map((item) => item.id),
      });
  };
  const handleExportConnectionsRef = useRef(handleExportConnections);
  handleExportConnectionsRef.current = handleExportConnections;

  // === Excel 批量导入（issue #1226）：统一入口按格式分流 ===
  // Excel 导入结果里分组按连接名声明；导入完成后按名字→ID 映射把连接挂入
  // 既有或新建的分组（"父分组/子分组" 逐级查/建），并沿用导入面板的目标分组兜底。
  const applyExcelGroupAssignments = async (excelGroups: ExcelGroupAssignment[], importedConnections: SavedConnection[]) => {
      if (!Array.isArray(excelGroups) || excelGroups.length === 0) return 0;
      await connectionSidebarLayoutCoordinatorRef.current?.bootstrap();
      const tags = useStore.getState().connectionTags;
      const resolveTagId = (name: string, parentTagId: string | undefined) => {
          const found = tags.find((tag) => (
              tag.parentTagId === (parentTagId || undefined)
              && String(tag.name || '').localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
          ));
          return found?.id;
      };
      let nextTagSeq = 0;
      const context: ExcelGroupPlanContext = {
          resolveTagId,
          nextTagId: () => `${Date.now()}-${nextTagSeq++}`,
      };
      const plan = planExcelGroupAssignments(excelGroups, context);
      if (plan.tagsToCreate.length > 0) {
          plan.tagsToCreate.forEach((tag) => {
              useStore.getState().addConnectionTag({
                  id: tag.id,
                  name: tag.name,
                  parentTagId: tag.parentTagId,
                  connectionIds: [],
              });
          });
      }
      const nameToId = new Map(importedConnections.map((conn) => [conn.name, conn.id]));
      let movedCount = 0;
      Object.entries(plan.movesByLeafTagId).forEach(([leafTagId, connectionNames]) => {
          const ids = connectionNames
              .map((name) => nameToId.get(name))
              .filter((id): id is string => Boolean(id));
          if (ids.length === 0) return;
          useStore.getState().moveConnectionsToTag(ids, leafTagId);
          movedCount += ids.length;
      });
      if (movedCount > 0 || plan.tagsToCreate.length > 0) {
          try {
              await connectionSidebarLayoutCoordinatorRef.current?.flush();
          } catch (error) {
              const detail = error instanceof Error ? error.message : String(error ?? '').trim();
              throw new Error(t('app.connection_package.import.group_save_failed', { detail }));
          }
      }
      return movedCount;
  };

  const finishExcelImport = async (result: any, sourceGroup?: ToolCenterGroupKey) => {
      const imported = normalizeConnectionPackageImportPayload(result?.data);
      if (!imported || imported.connections.length === 0) {
          throw new Error(t('app.connection_package.error.import_no_connections'));
      }
      const targetTagId = String(connectionImportTargetTagId || '').trim();
      const placement = resolveConnectionImportPlacement(
          imported.connections.map((connection) => connection.id),
          targetTagId,
          useStore.getState().connectionTags,
      );
      placement.manualOrderTargetGroupIds.forEach((groupID) => {
          setConnectionDisplaySortMode(groupID, 'manual');
      });
      await refreshConnectionsAfterImport(imported.connections);
      if (placement.groupAssignment) {
          moveConnectionsToTag(
              placement.groupAssignment.connectionIds,
              placement.groupAssignment.targetGroupId,
          );
      }
      const movedByExcel = await applyExcelGroupAssignments(imported.excelGroups || [], imported.connections);
      if (sourceGroup) {
          setToolCenterBackGroupKey(sourceGroup);
          setActiveSettingsCenterGroupKey(sourceGroup);
          setActiveSettingsCenterPane({ key: 'import', group: sourceGroup });
      }
      const summary = movedByExcel > 0
          ? t('app.connection_package.excel.groups_applied', { count: imported.connections.length, groupCount: movedByExcel })
          : t('app.connection_package.message.imported_connections', { count: imported.connections.length });
      setConnectionImportNotice({ type: 'success', message: summary });
      void message.success(summary);
  };

  const handleConfirmConnectionPackageDialog = async () => {
      const backendApp = (window as any).go?.app?.App;
      const password = normalizeConnectionPackagePassword(connectionPackageDialog.password);

      if (connectionPackageDialog.mode === 'import' && !password) {
          setConnectionPackageDialog((current) => ({
              ...current,
              error: t('app.connection_package.error.restore_password_required'),
          }));
          return;
      }

      if (
          connectionPackageDialog.mode === 'export'
          && connectionPackageDialog.selectedConnectionIds.length === 0
      ) {
          setConnectionPackageDialog((current) => ({
              ...current,
              error: t('app.connection_package.error.no_selected_connections'),
          }));
          return;
      }

      if (
          connectionPackageDialog.mode === 'export'
          && connectionPackageDialog.includeSecrets
          && connectionPackageDialog.useFilePassword
          && !password
      ) {
          setConnectionPackageDialog((current) => ({
              ...current,
              error: t('app.connection_package.error.file_password_required'),
          }));
          return;
      }

      setConnectionPackageDialog((current) => ({
          ...current,
          password: (
              current.mode === 'export'
              && (!current.includeSecrets || !current.useFilePassword)
          ) ? '' : password,
          error: '',
          confirmLoading: true,
      }));

      try {
          if (connectionPackageDialog.mode === 'export') {
               const exportMethod = isWebRuntime
                   ? backendApp?.ExportConnectionsPayload
                   : backendApp?.ExportConnectionsPackage;
               if (typeof exportMethod !== 'function') {
                   throw new Error(t('app.connection_package.error.export_capability_unavailable'));
               }

               let res: unknown;
               try {
                   res = await exportMethod({
                      includeSecrets: connectionPackageDialog.includeSecrets,
                      filePassword: (
                          connectionPackageDialog.includeSecrets
                          && connectionPackageDialog.useFilePassword
                      ) ? password : '',
                      connectionIds: connectionPackageDialog.selectedConnectionIds,
                      // Redis DB 别名仅存前端，导出时注入连接包
                      redisDbAliases: useStore.getState().appearance.redisDbAliases,
                  });
              } catch (error) {
                  const detail = error instanceof Error ? error.message : String(error ?? '').trim();
                  throw new Error(
                      detail
                          ? `${t('app.connection_package.message.export_failed')}: ${detail}`
                          : t('app.connection_package.message.export_failed'),
                  );
              }
              const exportResult = resolveConnectionPackageExportResult(connectionPackageDialog, res);
              if (exportResult.kind === 'canceled') {
                  setConnectionPackageDialog(exportResult.nextDialog);
                  return;
              }
               if (exportResult.kind === 'failed') {
                   throw new Error(exportResult.error);
               }
               if (isWebRuntime) {
                   const content = typeof (res as any)?.data === 'string' ? (res as any).data : '';
                   if (!content || !downloadBrowserTextFile(content, 'connections.gonavi-conn', 'application/json;charset=utf-8')) {
                       throw new Error(t('app.connection_package.error.export_capability_unavailable'));
                   }
               }

              setConnectionPackageDialog((current) => ({
                  ...current,
                  password: '',
                  error: '',
                  confirmLoading: false,
              }));
              void message.success(t('app.connection_package.message.export_succeeded'));
              return;
          }

          if (!pendingConnectionImportPayload) {
              throw new Error(t('app.connection_package.error.missing_import_payload'));
          }

          const importedViews = await importConnectionsPayload(pendingConnectionImportPayload, password);
          const success = t('app.connection_package.message.imported_connections', { count: importedViews.length });
          setPendingConnectionImportPayload(null);
          setConnectionImportNotice({ type: 'success', message: success });
          setConnectionPackageDialog((current) => ({
              ...current,
              open: false,
              password: '',
              error: '',
              confirmLoading: false,
          }));
          void message.success(success);
      } catch (e: any) {
          setConnectionPackageDialog((current) => ({
              ...current,
              confirmLoading: false,
              error: e?.message || t(
                  current.mode === 'export'
                      ? 'app.connection_package.message.export_failed'
                      : 'app.connection_package.message.import_failed',
              ),
          }));
      }
  };
  return {
    handleBrowserConnectionImportFileChange, handleImportConnections, handleExportConnections,
    handleExportConnectionsRef, handleConfirmConnectionPackageDialog,
  };
};

export type AppConnectionImportExportApi = ReturnType<typeof useAppConnectionImportExport>;
