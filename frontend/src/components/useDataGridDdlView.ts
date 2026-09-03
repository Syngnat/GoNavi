import React from 'react';
import { DBShowCreateTable } from '../../wailsjs/go/app/App';
import { t as catalogTranslate } from '../i18n/catalog';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { formatDdlForDisplay } from '../utils/ddlFormat';

type GridViewMode = 'table' | 'json' | 'text' | 'fields' | 'ddl' | 'er' | 'sqlLog';
type DdlViewLayoutMode = 'bottom' | 'side';
type TranslateParams = Record<string, string | number | boolean | null | undefined>;
const GRID_VIEW_MODES: GridViewMode[] = ['table', 'json', 'text', 'fields', 'ddl', 'er', 'sqlLog'];
const V2_ONLY_GRID_VIEW_MODES = new Set<GridViewMode>(['fields', 'ddl', 'er', 'sqlLog']);
const DDL_VIEW_LAYOUT_STORAGE_KEY = 'gonavi.dataGrid.ddlViewLayout';
let sharedDdlViewOpen = false;
let sharedDdlViewLayout: DdlViewLayoutMode | null = null;
const ddlViewLayoutListeners = new Set<(layout: DdlViewLayoutMode) => void>();

const sanitizeDdlViewLayout = (value: unknown): DdlViewLayoutMode => (
  value === 'side' ? 'side' : 'bottom'
);

const readPersistedDdlViewLayout = (): DdlViewLayoutMode => {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
    return sanitizeDdlViewLayout(storage?.getItem(DDL_VIEW_LAYOUT_STORAGE_KEY));
  } catch {
    return 'bottom';
  }
};

const persistDdlViewLayout = (layout: DdlViewLayoutMode) => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage?.setItem(DDL_VIEW_LAYOUT_STORAGE_KEY, layout);
    }
  } catch {
    // Ignore storage failures in restricted runtimes.
  }
};

const readSharedDdlViewLayout = (): DdlViewLayoutMode => {
  if (!sharedDdlViewLayout) {
    sharedDdlViewLayout = readPersistedDdlViewLayout();
  }
  return sharedDdlViewLayout;
};

const setSharedDdlViewLayout = (layout: DdlViewLayoutMode) => {
  sharedDdlViewLayout = layout;
  persistDdlViewLayout(layout);
  ddlViewLayoutListeners.forEach((listener) => listener(layout));
};

const setSharedDdlViewOpen = (open: boolean) => {
  sharedDdlViewOpen = open;
};

const shouldRestoreSharedDdlView = () => sharedDdlViewOpen;

export const resetDataGridDdlViewSharedStateForTests = () => {
  sharedDdlViewOpen = false;
  sharedDdlViewLayout = null;
  ddlViewLayoutListeners.clear();
};

const buildDdlContextKey = (currentConnConfig: unknown, dbName?: string, tableName?: string) => {
  const config = (currentConnConfig || {}) as Record<string, unknown>;
  return [
    String(config.type || ''),
    String(config.host || ''),
    String(config.port || ''),
    String(config.database || ''),
    dbName || '',
    tableName || '',
  ].join('\u0001');
};

const resolveInitialGridViewMode = (
  initialViewMode: GridViewMode | undefined,
  isV2Ui: boolean,
  canViewDdl: boolean,
): GridViewMode | null => {
  if (!initialViewMode || !GRID_VIEW_MODES.includes(initialViewMode)) return null;
  if (!isV2Ui && V2_ONLY_GRID_VIEW_MODES.has(initialViewMode)) return null;
  if (initialViewMode === 'ddl' && !canViewDdl) return null;
  return initialViewMode;
};

interface UseDataGridDdlViewParams {
  canViewDdl: boolean;
  currentConnConfig: unknown;
  dbName?: string;
  tableName?: string;
  isV2Ui: boolean;
  isActive?: boolean;
  cellEditMode: boolean;
  selectedRowKeys: React.Key[];
  mergedDisplayDataRef: React.MutableRefObject<any[]>;
  rowKeyStr: (key: React.Key) => string;
  closeCellEditModeRef: React.MutableRefObject<() => void>;
  setTextRecordIndex: React.Dispatch<React.SetStateAction<number>>;
  messageApi: {
    error: (content: string) => void;
  };
  dbType?: string;
  translate?: (key: string, params?: TranslateParams) => string;
  initialViewMode?: GridViewMode;
  initialViewModeRequestId?: string;
  initialViewModeScope?: 'shared' | 'local';
}

export interface UseDataGridDdlViewResult {
  viewMode: GridViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<GridViewMode>>;
  ddlModalOpen: boolean;
  setDdlModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  ddlLoading: boolean;
  ddlText: string;
  ddlViewLayout: DdlViewLayoutMode;
  setDdlViewLayout: React.Dispatch<React.SetStateAction<DdlViewLayoutMode>>;
  ddlSidebarWidth: number;
  ddlSidebarResizePreviewX: number | null;
  ddlRequestSeqRef: React.MutableRefObject<number>;
  isTableSurfaceActive: boolean;
  handleOpenTableDdl: (options?: { asView?: boolean }) => Promise<void>;
  handleViewModeChange: (nextMode: GridViewMode, options?: { textRecordIndex?: number }) => void;
  handleDdlSidebarResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  resetDdlViewState: () => void;
  closeDdlView: () => void;
}

export const useDataGridDdlView = ({
  canViewDdl,
  currentConnConfig,
  dbName,
  tableName,
  isV2Ui,
  isActive = true,
  cellEditMode,
  selectedRowKeys,
  mergedDisplayDataRef,
  rowKeyStr,
  closeCellEditModeRef,
  setTextRecordIndex,
  messageApi,
  dbType,
  translate,
  initialViewMode,
  initialViewModeRequestId,
  initialViewModeScope,
}: UseDataGridDdlViewParams): UseDataGridDdlViewResult => {
  const initialResolvedViewMode = resolveInitialGridViewMode(initialViewMode, isV2Ui, canViewDdl);
  const shouldInitiallySuppressSharedDdlView = initialViewModeScope === 'local'
    && initialResolvedViewMode === 'table';
  const [suppressSharedDdlView, setSuppressSharedDdlView] = React.useState(shouldInitiallySuppressSharedDdlView);
  const canRestoreSharedDdlView = isV2Ui
    && canViewDdl
    && !!currentConnConfig
    && !!tableName
    && !suppressSharedDdlView
    && shouldRestoreSharedDdlView();
  const shouldStartWithSharedDdlView = isActive && canRestoreSharedDdlView;
  const [viewMode, setViewMode] = React.useState<GridViewMode>(() => (
    shouldStartWithSharedDdlView ? 'ddl' : (initialResolvedViewMode || 'table')
  ));
  const [ddlModalOpen, setDdlModalOpen] = React.useState(false);
  const [ddlLoading, setDdlLoading] = React.useState(shouldStartWithSharedDdlView);
  const [ddlText, setDdlText] = React.useState('');
  const [ddlViewLayoutState, setDdlViewLayoutState] = React.useState<DdlViewLayoutMode>(readSharedDdlViewLayout);
  const [ddlSidebarWidth, setDdlSidebarWidth] = React.useState(420);
  const [ddlSidebarResizePreviewX, setDdlSidebarResizePreviewX] = React.useState<number | null>(null);
  const ddlSidebarResizeRef = React.useRef<{
    startX: number;
    startWidth: number;
    previewWidth: number;
    previewX: number | null;
    previewElement?: HTMLElement | null;
    previewFrame?: number | null;
    moveHandler?: (event: MouseEvent) => void;
    upHandler?: () => void;
  } | null>(null);
  const ddlRequestSeqRef = React.useRef(0);
  const ddlRequestedContextKeyRef = React.useRef<string | null>(null);
  const ddlContextKey = React.useMemo(
    () => buildDdlContextKey(currentConnConfig, dbName, tableName),
    [currentConnConfig, dbName, tableName],
  );
  const appliedInitialViewModeKeyRef = React.useRef('');
  const initialViewModeApplyKey = `${ddlContextKey}\u0001${initialResolvedViewMode || ''}\u0001${initialViewModeRequestId || ''}\u0001${initialViewModeScope || 'shared'}`;
  const hasPendingLocalTableViewRequest = isActive
    && initialResolvedViewMode === 'table'
    && initialViewModeScope === 'local'
    && appliedInitialViewModeKeyRef.current !== initialViewModeApplyKey;

  const ddlViewLayout = ddlViewLayoutState;
  const resolvedViewMode: GridViewMode = hasPendingLocalTableViewRequest
    ? 'table'
    : isActive
      && canRestoreSharedDdlView
      && (viewMode === 'table' || viewMode === 'ddl')
      ? 'ddl'
      : viewMode;
  const isDdlContextPending = resolvedViewMode === 'ddl'
    && isActive
    && canRestoreSharedDdlView
    && ddlRequestedContextKeyRef.current !== ddlContextKey;
  const resolvedDdlLoading = ddlLoading || isDdlContextPending;
  const resolvedDdlText = isDdlContextPending ? '' : ddlText;
  const isTableSurfaceActive = resolvedViewMode === 'table' || (isV2Ui && resolvedViewMode === 'ddl' && ddlViewLayout === 'side');

  const translateMessage = React.useCallback((key: string, params?: TranslateParams) => {
    return translate ? translate(key, params) : catalogTranslate('zh-CN', key, params);
  }, [translate]);

  const setDdlViewLayout: React.Dispatch<React.SetStateAction<DdlViewLayoutMode>> = React.useCallback((nextLayout) => {
    const currentLayout = readSharedDdlViewLayout();
    const resolvedLayout = sanitizeDdlViewLayout(
      typeof nextLayout === 'function' ? nextLayout(currentLayout) : nextLayout,
    );
    setSharedDdlViewLayout(resolvedLayout);
  }, []);

  React.useEffect(() => {
    const handleSharedDdlViewLayoutChange = (nextLayout: DdlViewLayoutMode) => {
      setDdlViewLayoutState((currentLayout) => (
        currentLayout === nextLayout ? currentLayout : nextLayout
      ));
    };
    ddlViewLayoutListeners.add(handleSharedDdlViewLayoutChange);
    handleSharedDdlViewLayoutChange(readSharedDdlViewLayout());
    return () => {
      ddlViewLayoutListeners.delete(handleSharedDdlViewLayoutChange);
    };
  }, []);

  const handleOpenTableDdl = React.useCallback(async (options?: { asView?: boolean }) => {
    if (!canViewDdl || !currentConnConfig || !tableName) {
      messageApi.error(translateMessage('data_grid.message.ddl_missing_context'));
      return;
    }
    const asView = options?.asView === true && isV2Ui;
    const requestSeq = ++ddlRequestSeqRef.current;
    ddlRequestedContextKeyRef.current = ddlContextKey;
    if (asView) {
      setSuppressSharedDdlView(false);
      setSharedDdlViewOpen(true);
      setViewMode('ddl');
      setDdlModalOpen(false);
    } else {
      setDdlModalOpen(true);
    }
    setDdlLoading(true);
    setDdlText('');
    try {
      const res = await DBShowCreateTable(buildRpcConnectionConfig(currentConnConfig as any) as any, dbName || '', tableName);
      if (requestSeq !== ddlRequestSeqRef.current) return;
      if (res.success) {
        setDdlText(formatDdlForDisplay(
          res.data,
          dbType || String((currentConnConfig as any)?.type || ''),
          { oceanBaseProtocol: (currentConnConfig as any)?.oceanBaseProtocol },
        ));
        return;
      }
      messageApi.error(res.message || translateMessage('data_grid.message.ddl_load_failed'));
    } catch (error: any) {
      if (requestSeq !== ddlRequestSeqRef.current) return;
      messageApi.error(error?.message || translateMessage('data_grid.message.ddl_load_failed'));
    } finally {
      if (requestSeq === ddlRequestSeqRef.current) {
        setDdlLoading(false);
      }
    }
  }, [canViewDdl, currentConnConfig, dbName, dbType, ddlContextKey, isV2Ui, messageApi, tableName, translateMessage]);

  React.useEffect(() => {
    if (isV2Ui || (viewMode !== 'fields' && viewMode !== 'ddl' && viewMode !== 'er' && viewMode !== 'sqlLog')) return;
    setViewMode('table');
  }, [isV2Ui, viewMode]);

  const closeDdlView = React.useCallback(() => {
    setSuppressSharedDdlView(false);
    setSharedDdlViewOpen(false);
    ddlRequestedContextKeyRef.current = null;
    ddlRequestSeqRef.current += 1;
    setViewMode('table');
    setDdlModalOpen(false);
    setDdlLoading(false);
    setDdlText('');
    setDdlSidebarResizePreviewX(null);
  }, []);

  React.useEffect(() => {
    if (!isActive || hasPendingLocalTableViewRequest || !canRestoreSharedDdlView) return;
    if (ddlRequestedContextKeyRef.current === ddlContextKey) return;
    void handleOpenTableDdl({ asView: true });
  }, [canRestoreSharedDdlView, ddlContextKey, handleOpenTableDdl, hasPendingLocalTableViewRequest, isActive]);

  const handleViewModeChange = React.useCallback((nextMode: GridViewMode, options?: { textRecordIndex?: number }) => {
    setSuppressSharedDdlView(false);
    if ((nextMode === 'fields' || nextMode === 'ddl' || nextMode === 'er' || nextMode === 'sqlLog') && !isV2Ui) {
      setSharedDdlViewOpen(false);
      setViewMode('table');
      return;
    }
    if (nextMode === 'sqlLog') {
      setSharedDdlViewOpen(false);
      setViewMode('sqlLog');
      return;
    }
    if (nextMode === 'ddl') {
      if (isV2Ui && resolvedViewMode === 'ddl') {
        closeDdlView();
        return;
      }
      void handleOpenTableDdl({ asView: true });
      return;
    }
    setSharedDdlViewOpen(false);
    if (nextMode === 'json' && cellEditMode) {
      closeCellEditModeRef.current();
    }

    if (nextMode === 'text') {
      const explicitIndex = options?.textRecordIndex;
      if (explicitIndex !== undefined && Number.isFinite(explicitIndex)) {
        const maxIndex = Math.max(0, mergedDisplayDataRef.current.length - 1);
        setTextRecordIndex(Math.max(0, Math.min(Math.trunc(explicitIndex), maxIndex)));
      } else {
        const selectedKey = selectedRowKeys[0];
        if (selectedKey !== undefined) {
          const idx = mergedDisplayDataRef.current.findIndex((row) => rowKeyStr(row?.__gonavi_row_key__) === rowKeyStr(selectedKey));
          if (idx >= 0) {
            setTextRecordIndex(idx);
          }
        }
      }
    }

    setViewMode(nextMode);
  }, [cellEditMode, closeCellEditModeRef, closeDdlView, handleOpenTableDdl, isV2Ui, mergedDisplayDataRef, resolvedViewMode, rowKeyStr, selectedRowKeys, setTextRecordIndex]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!initialResolvedViewMode) return;
    if (appliedInitialViewModeKeyRef.current === initialViewModeApplyKey) return;
    appliedInitialViewModeKeyRef.current = initialViewModeApplyKey;
    if (initialResolvedViewMode === 'table' && initialViewModeScope === 'local') {
      setSuppressSharedDdlView(true);
      setViewMode('table');
      return;
    }
    handleViewModeChange(initialResolvedViewMode);
  }, [handleViewModeChange, initialResolvedViewMode, initialViewModeApplyKey, initialViewModeScope, isActive]);

  const handleDdlSidebarResizeStart = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = ddlSidebarWidth;
    const resizerElement = event.currentTarget;
    const workspaceElement = resizerElement.parentElement;
    const previewElement = workspaceElement?.querySelector?.('[data-grid-ddl-resize-preview="true"]') as HTMLElement | null | undefined;
    const workspaceWidth = workspaceElement?.getBoundingClientRect?.().width;
    const resizerWidth = resizerElement.getBoundingClientRect?.().width || 8;
    const resolvePreviewX = (width: number, fallbackX: number) => (
      typeof workspaceWidth === 'number' && workspaceWidth > 0
        ? Math.max(0, workspaceWidth - width - resizerWidth / 2)
        : fallbackX
    );
    const applyPreviewElementPosition = (x: number | null) => {
      if (!previewElement) return;
      if (x === null) {
        previewElement.style.opacity = '0';
        previewElement.style.transform = 'translate3d(0, 0, 0)';
        return;
      }
      previewElement.style.opacity = '1';
      previewElement.style.transform = `translateX(${x}px)`;
    };
    const schedulePreviewElementPosition = (x: number) => {
      const state = ddlSidebarResizeRef.current;
      if (!state?.previewElement) return false;
      state.previewX = x;
      if (state.previewFrame !== null && state.previewFrame !== undefined) return true;
      const run = () => {
        const current = ddlSidebarResizeRef.current;
        if (!current?.previewElement) return;
        current.previewFrame = null;
        applyPreviewElementPosition(current.previewX);
      };
      if (typeof requestAnimationFrame === 'function') {
        state.previewFrame = requestAnimationFrame(run);
      } else {
        run();
      }
      return true;
    };
    const startPreviewX = resolvePreviewX(startWidth, startX);
    const moveHandler = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(320, Math.min(760, startWidth + (startX - moveEvent.clientX)));
      if (ddlSidebarResizeRef.current) {
        ddlSidebarResizeRef.current.previewWidth = nextWidth;
      }
      const nextPreviewX = resolvePreviewX(nextWidth, moveEvent.clientX);
      if (!schedulePreviewElementPosition(nextPreviewX)) {
        setDdlSidebarResizePreviewX(nextPreviewX);
      }
    };
    const upHandler = () => {
      const resizeState = ddlSidebarResizeRef.current;
      const nextWidth = resizeState?.previewWidth ?? startWidth;
      if (resizeState?.previewFrame !== null && resizeState?.previewFrame !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(resizeState.previewFrame);
      }
      applyPreviewElementPosition(null);
      setDdlSidebarWidth(nextWidth);
      setDdlSidebarResizePreviewX(null);
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      ddlSidebarResizeRef.current = null;
    };

    ddlSidebarResizeRef.current = {
      startX,
      startWidth,
      previewWidth: startWidth,
      previewX: startPreviewX,
      previewElement,
      previewFrame: null,
      moveHandler,
      upHandler,
    };
    if (previewElement) {
      applyPreviewElementPosition(startPreviewX);
    } else {
      setDdlSidebarResizePreviewX(startPreviewX);
    }
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }, [ddlSidebarWidth]);

  const resetDdlViewState = React.useCallback(() => {
    ddlRequestedContextKeyRef.current = null;
    ddlRequestSeqRef.current += 1;
    setDdlModalOpen(false);
    setDdlLoading(false);
    setDdlText('');
    setDdlSidebarResizePreviewX(null);
  }, []);

  return {
    viewMode: resolvedViewMode,
    setViewMode,
    ddlModalOpen,
    setDdlModalOpen,
    ddlLoading: resolvedDdlLoading,
    ddlText: resolvedDdlText,
    ddlViewLayout,
    setDdlViewLayout,
    ddlSidebarWidth,
    ddlSidebarResizePreviewX,
    ddlRequestSeqRef,
    isTableSurfaceActive,
    handleOpenTableDdl,
    handleViewModeChange,
    handleDdlSidebarResizeStart,
    resetDdlViewState,
    closeDdlView,
  };
};
