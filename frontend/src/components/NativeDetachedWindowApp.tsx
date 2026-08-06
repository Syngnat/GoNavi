import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfigProvider, Segmented, Spin, Tag, Tooltip, theme as antdTheme } from 'antd';
import { CloseOutlined, CompressOutlined } from '@ant-design/icons';
import { EventsOn } from '../../wailsjs/runtime';

import { t as defaultTranslate } from '../i18n';
import { getAntdLocale } from '../i18n/frameworkLocale';
import { useOptionalI18n } from '../i18n/provider';
import { flushAIChatSessionPersistence, type SqlLog, useStore } from '../store';
import type { TabData } from '../types';
import type { DetachedQueryResultWindow } from '../utils/detachedWindow';
import {
  attachNativeDetachedWindow,
  advanceNativeDetachedStoreSource,
  applyNativeDetachedHostStateCommand,
  buildNativeDetachedAIChatSyncStoreSnapshot,
  buildNativeDetachedChangedWorkbenchStoreSnapshot,
  buildNativeDetachedStoreSnapshot,
  buildNativeDetachedSyncStoreSnapshot,
  buildNativeDetachedWorkbenchMutableStoreSnapshot,
  cancelNativeDetachedWindowClose,
  cancelCurrentNativeDetachedWindowClose,
  closeCurrentNativeDetachedWindow,
  closeNativeDetachedWindow,
  fetchNativeDetachedWindowBootstrap,
  hydrateNativeDetachedStore,
  hideCurrentNativeDetachedWindow,
  hideCurrentNativeDetachedWindowForAISettings,
  hideNativeDetachedWindow,
  presentCurrentNativeDetachedWindow,
  readyNativeDetachedWindow,
  sendNativeDetachedHostEvent,
  syncNativeDetachedWindow,
  readNativeDetachedThemeContext,
  type NativeDetachedHostEvent,
  type NativeDetachedHostEventName,
  type NativeDetachedStoreSnapshot,
  type NativeDetachedWindowActionPayload,
  type NativeDetachedWindowBootstrap,
  NATIVE_DETACHED_WINDOW_COMMAND_EVENT,
  type NativeDetachedHostStateCommand,
} from '../utils/nativeDetachedWindowClient';
import type { CustomThemeDefinition } from '../utils/customTheme';
import { isMacLikePlatform } from '../utils/appearance';
import {
  peekQueryEditorResultSession,
  saveQueryEditorResultSession,
  subscribeQueryEditorResultSession,
  type QueryEditorResultSessionSnapshot,
} from '../utils/queryEditorResultSessionCache';
import { buildOverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import { APP_OVERLAY_Z_INDEX_BASE } from '../utils/overlayZIndex';
import { resolveLiveQueryTab, resolveLiveQueryTabs } from '../utils/liveQueryTabs';
import { subscribeQueryTabDraftChanges } from '../utils/sqlFileTabDrafts';
import CustomThemeStyleHost, {
  type CustomThemeAntTokenSnapshot,
} from './theme/CustomThemeStyleHost';
import {
  getShortcutPlatform,
  installGlobalImeCompositionTracking,
  isShortcutMatch,
  resolveShortcutBinding,
} from '../utils/shortcuts';
const AIChatPanel = React.lazy(() => import('./AIChatPanel'));
const DataGrid = React.lazy(() => import('./DataGrid'));
const WorkbenchTabContent = React.lazy(() => import('./WorkbenchTabContent'));
const NativeDetachedWindowController = React.lazy(
  () => import('./NativeDetachedWindowController'),
);

export const NATIVE_DETACHED_SYNC_DEBOUNCE_MS = 180;
export const NATIVE_DETACHED_PAINT_FALLBACK_MS = 250;
const NATIVE_DETACHED_CANCEL_CLOSE_ATTEMPTS = 2;
const NATIVE_DETACHED_MIN_UI_SCALE = 0.8;
const NATIVE_DETACHED_MAX_UI_SCALE = 1.25;
const NATIVE_DETACHED_DEFAULT_UI_SCALE = 1;
const NATIVE_DETACHED_MIN_FONT_SIZE = 12;
const NATIVE_DETACHED_MAX_FONT_SIZE = 20;
const NATIVE_DETACHED_DEFAULT_FONT_SIZE = 14;

type NativeDetachedDocument = Pick<Document, 'body' | 'documentElement'>;

export const applyNativeDetachedDocumentAppearance = (
  themeMode: 'light' | 'dark',
  uiVersion: 'legacy' | 'v2',
  fontSize: number,
  uiScale: number,
  documentRef: NativeDetachedDocument | null = typeof document === 'undefined' ? null : document,
): void => {
  if (!documentRef?.body) return;
  const resolvedTheme = themeMode === 'dark' ? 'dark' : 'light';
  const effectiveUiScale = Math.min(
    NATIVE_DETACHED_MAX_UI_SCALE,
    Math.max(NATIVE_DETACHED_MIN_UI_SCALE, Number(uiScale) || NATIVE_DETACHED_DEFAULT_UI_SCALE),
  );
  const effectiveFontSize = Math.min(
    NATIVE_DETACHED_MAX_FONT_SIZE,
    Math.max(NATIVE_DETACHED_MIN_FONT_SIZE, Math.round(Number(fontSize) || NATIVE_DETACHED_DEFAULT_FONT_SIZE)),
  );
  const rootStyle = documentRef.documentElement?.style;
  documentRef.body.setAttribute('data-theme', resolvedTheme);
  documentRef.body.setAttribute('data-ui-version', uiVersion);
  documentRef.body.setAttribute('data-gonavi-detached', 'true');
  documentRef.body.style.backgroundColor = 'transparent';
  documentRef.body.style.color = resolvedTheme === 'dark' ? '#ffffff' : '#000000';
  documentRef.body.style.fontSize = `${effectiveFontSize}px`;
  if (!rootStyle) return;
  rootStyle.colorScheme = resolvedTheme;
  rootStyle.setProperty('--gonavi-font-size', `${effectiveFontSize}px`);
  rootStyle.setProperty('--gn-ui-scale', `${effectiveUiScale}`);
  rootStyle.setProperty('--gn-font-size', `${effectiveFontSize}px`);
  rootStyle.setProperty('--gn-font-size-sm', `${Math.max(10, Math.round(effectiveFontSize * 0.86))}px`);
  rootStyle.setProperty('--gn-font-size-xs', `${Math.max(9, Math.round(effectiveFontSize * 0.76))}px`);
};

export const waitForNativeDetachedContentPaint = (): Promise<void> => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      resolve();
    };
    fallbackTimer = setTimeout(finish, NATIVE_DETACHED_PAINT_FALLBACK_MS);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(finish);
    });
  });
};

type NativeDetachedWindowClient = {
  load: () => Promise<NativeDetachedWindowBootstrap>;
  present?: () => Promise<void>;
  ready: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  sync: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  attach: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  hide?: (payload: NativeDetachedWindowActionPayload) => Promise<number>;
  close: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  cancelCloseRequest?: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  openAISettings: (visibilityRevision: number) => Promise<void>;
  hostEvent?: (payload: NativeDetachedWindowActionPayload) => Promise<void>;
  closeCurrentWindow: () => Promise<void>;
  hideCurrentWindow?: (visibilityRevision: number) => Promise<void>;
  cancelClose?: () => Promise<void>;
};

const defaultClient: NativeDetachedWindowClient = {
  load: fetchNativeDetachedWindowBootstrap,
  present: presentCurrentNativeDetachedWindow,
  ready: readyNativeDetachedWindow,
  sync: syncNativeDetachedWindow,
  attach: attachNativeDetachedWindow,
  hide: hideNativeDetachedWindow,
  close: closeNativeDetachedWindow,
  cancelCloseRequest: cancelNativeDetachedWindowClose,
  openAISettings: hideCurrentNativeDetachedWindowForAISettings,
  hostEvent: sendNativeDetachedHostEvent,
  closeCurrentWindow: closeCurrentNativeDetachedWindow,
  hideCurrentWindow: hideCurrentNativeDetachedWindow,
  cancelClose: cancelCurrentNativeDetachedWindowClose,
};

export interface NativeDetachedWindowAppProps {
  client?: NativeDetachedWindowClient;
}

const isAffectedRowsResult = (columns: string[]): boolean =>
  columns.length === 1 && columns[0] === 'affectedRows';

const buildActionPayload = (
  bootstrap: NativeDetachedWindowBootstrap,
  tab?: TabData,
  resultSession?: QueryEditorResultSessionSnapshot | null,
  includeResultSession = false,
  newSqlLogs: SqlLog[] = [],
  revision?: number,
  workbenchState?: NativeDetachedStoreSnapshot,
  workbenchStateBase?: NativeDetachedStoreSnapshot,
  openedTabs: TabData[] = [],
  clearSqlLogs = false,
  resultWindow?: DetachedQueryResultWindow | null,
): NativeDetachedWindowActionPayload => {
  const storeState = bootstrap.kind === 'ai-chat'
    ? buildNativeDetachedAIChatSyncStoreSnapshot(useStore.getState(), newSqlLogs)
    : buildNativeDetachedSyncStoreSnapshot(
        useStore.getState(),
        bootstrap.kind === 'workbench' ? bootstrap.payload.tab?.id || '' : '',
        newSqlLogs,
      );
  const screenX = typeof window === 'undefined' ? Number.NaN : Number(window.screenX);
  const screenY = typeof window === 'undefined' ? Number.NaN : Number(window.screenY);
  const width = typeof window === 'undefined'
    ? Number.NaN
    : Number(window.outerWidth || window.innerWidth);
  const height = typeof window === 'undefined'
    ? Number.NaN
    : Number(window.outerHeight || window.innerHeight);
  const bounds = [screenX, screenY, width, height].every(Number.isFinite)
    && width > 0
    && height > 0
    ? {
        x: Math.round(screenX),
        y: Math.round(screenY),
        width: Math.round(width),
        height: Math.round(height),
      }
    : undefined;
  return {
    id: bootstrap.id,
    kind: bootstrap.kind,
    ...(revision && revision > 0 ? { revision } : {}),
    ...(bounds ? { bounds } : {}),
    ...(workbenchState && Object.keys(workbenchState).length > 0 ? { workbenchState } : {}),
    ...(workbenchState && Object.keys(workbenchState).length > 0
      ? { workbenchStateBase: workbenchStateBase ?? {} }
      : {}),
    ...(openedTabs.length > 0 ? { openedTabs } : {}),
    ...(clearSqlLogs ? { clearSqlLogs: true } : {}),
    ...(bootstrap.kind === 'workbench' || Object.keys(storeState).length > 0
      ? { storeState }
      : {}),
    ...(tab ? { tab } : {}),
    ...(bootstrap.kind === 'query-result' && resultWindow ? { resultWindow } : {}),
    ...(bootstrap.kind === 'workbench' && includeResultSession
      ? { resultSession: resultSession ?? null }
      : {}),
  };
};

const NativeDetachedQueryResult: React.FC<{
  windowState: DetachedQueryResultWindow;
  onDataChange: (rows: Array<Record<string, unknown>>) => void;
}> = ({ windowState, onDataChange }) => {
  const result = windowState.result;
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const themeMode = useStore((state) => state.theme);
  const [elasticsearchViewMode, setElasticsearchViewMode] = useState<'table' | 'raw'>('table');
  const isDark = themeMode === 'dark';
  if (result.resultType === 'elasticsearch') {
    const hasTable = Array.isArray(result.rows) && result.rows.length > 0 && (result.columns || []).length > 0;
    const viewMode = hasTable ? elasticsearchViewMode : 'raw';
    const status = Number(result.httpStatus || 0);
    const statusColor = status >= 200 && status < 300
      ? (result.partialFailure ? 'orange' : 'green')
      : 'red';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flex: '0 0 auto',
          borderBottom: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
        }}>
          <span style={{ fontFamily: 'var(--gn-font-mono)', fontWeight: 600 }}>
            {result.requestLabel || result.sql}
          </span>
          {status > 0 ? <Tag color={statusColor}>HTTP {status}</Tag> : null}
          {result.partialFailure ? <Tag color="orange">{t('query_editor.elasticsearch.partial')}</Tag> : null}
          {result.outcomeUnknown ? <Tag color="red">{t('query_editor.elasticsearch.outcome_unknown')}</Tag> : null}
          <span style={{ flex: 1 }} />
          {hasTable ? (
            <Segmented
              size="small"
              value={viewMode}
              options={[
                { label: t('query_editor.elasticsearch.table'), value: 'table' },
                { label: t('query_editor.elasticsearch.raw'), value: 'raw' },
              ]}
              onChange={(value) => setElasticsearchViewMode(value as 'table' | 'raw')}
            />
          ) : null}
        </div>
        {viewMode === 'raw' ? (
          <textarea
            aria-label={t('query_editor.elasticsearch.raw_response')}
            readOnly
            spellCheck={false}
            value={String(result.rawResponse || '')}
            style={{
              flex: 1, minHeight: 0, margin: 12, padding: 12, resize: 'none', overflow: 'auto',
              borderRadius: 6, fontFamily: 'var(--gn-font-mono)', whiteSpace: 'pre',
              color: isDark ? '#d4d4d4' : '#333',
              background: isDark ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.018)',
              border: isDark ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.10)',
            }}
          />
        ) : (
          <DataGrid
            data={result.rows || []}
            columnNames={result.columns || []}
            loading={false}
            pkColumns={[]}
            readOnly
            connectionId={windowState.connectionId}
            dbName={result.metadataDbName || windowState.dbName || ''}
            resultSql={result.sql}
            exportScope="queryResult"
            isActive
          />
        )}
      </div>
    );
  }
  const isMessage = result.resultType === 'message' || isAffectedRowsResult(result.columns || []);
  const messageText = (result.messages || []).join('\n')
    || (isAffectedRowsResult(result.columns || [])
      ? String(result.rows?.[0]?.affectedRows ?? '')
      : '');

  if (isMessage) {
    return (
      <textarea
        className="gn-native-detached-message"
        readOnly
        value={messageText}
      />
    );
  }

  return (
    <DataGrid
      data={result.rows || []}
      columnNames={result.columns || []}
      loading={false}
      tableName={result.tableName}
      pkColumns={result.pkColumns || []}
      editLocator={result.editLocator as any}
      readOnly={result.readOnly !== false}
      connectionId={windowState.connectionId}
      dbName={result.metadataDbName || windowState.dbName || ''}
      ddlDbName={result.ddlDbName}
      ddlTableName={result.ddlTableName}
      resultSql={result.exportSql || result.sql}
      exportScope="queryResult"
      showRowNumberColumn={result.showRowNumberColumn}
      onDataChange={onDataChange}
      isActive
    />
  );
};

const NativeDetachedWindowContent: React.FC<{
  bootstrap: NativeDetachedWindowBootstrap;
  themeModeOverride?: 'light' | 'dark';
  onContentReady: () => void;
  onAttach: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onRegisterAITerminalGuard: (guard: (() => Promise<boolean>) | null) => void;
  onQueryResultDataChange: (rows: Array<Record<string, unknown>>) => void;
  interactionDisabled?: boolean;
}> = ({
  bootstrap,
  themeModeOverride,
  onContentReady,
  onAttach,
  onClose,
  onOpenSettings,
  onRegisterAITerminalGuard,
  onQueryResultDataChange,
  interactionDisabled = false,
}) => {
  const tabFromStore = useStore((state) => bootstrap.payload.tab
    ? state.tabs.find((item) => item.id === bootstrap.payload.tab?.id)
    : undefined);
  const tab = tabFromStore || bootstrap.payload.tab;
  const storeThemeMode = useStore((state) => state.theme);
  const themeMode = themeModeOverride ?? storeThemeMode;
  const uiVersion = useStore((state) => state.appearance.uiVersion);

  if (bootstrap.kind === 'workbench') {
    return tab
      ? <WorkbenchTabContent tab={tab} isActive onContentReady={onContentReady} />
      : null;
  }
  if (bootstrap.kind === 'query-result') {
    return bootstrap.payload.resultWindow
      ? (
          <>
            <NativeDetachedQueryResult
              windowState={bootstrap.payload.resultWindow}
              onDataChange={onQueryResultDataChange}
            />
            <NativeDetachedContentReady onReady={onContentReady} />
          </>
        )
      : null;
  }
  const isDark = themeMode === 'dark';
  const aiPanelBackground = isDark
    ? 'var(--gn-bg-panel, #161a21)'
    : 'var(--gn-bg-panel, #ffffff)';
  return (
    <div className="gn-native-detached-ai-chat">
      <AIChatPanel
        width={typeof window === 'undefined' ? 440 : window.innerWidth}
        darkMode={isDark}
        bgColor={aiPanelBackground}
        overlayTheme={buildOverlayWorkbenchTheme(isDark, {
          disableBackdropFilter: true,
          uiVersion,
          useThemeVariables: true,
        })}
        presentation="detached"
        onClose={onClose}
        onAttach={onAttach}
        onOpenSettings={onOpenSettings}
        onRegisterTerminalGuard={onRegisterAITerminalGuard}
        interactionDisabled={interactionDisabled}
      />
      <NativeDetachedContentReady onReady={onContentReady} />
    </div>
  );
};

const NativeDetachedContentReady: React.FC<{ onReady: () => void }> = ({ onReady }) => {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
};

const NativeDetachedWindowApp: React.FC<NativeDetachedWindowAppProps> = ({
  client = defaultClient,
}) => {
  const i18n = useOptionalI18n();
  const translate = i18n?.t ?? defaultTranslate;
  const [bootstrap, setBootstrap] = useState<NativeDetachedWindowBootstrap | null>(null);
  const [loadError, setLoadError] = useState('');
  const [contentMounted, setContentMounted] = useState(true);
  const [contentReady, setContentReady] = useState(false);
  const [controllerEnabled, setControllerEnabled] = useState(false);
  // A detached WebView has an independent custom-theme store. The host sends
  // the resolved definition so it cannot fall back to a different local copy.
  const [customThemeOverride, setCustomThemeOverride] = useState<
    CustomThemeDefinition | null | undefined
  >(undefined);
  const markContentReady = useCallback(() => setContentReady(true), []);
  const [terminalAction, setTerminalAction] = useState<'attach' | 'hide' | 'close' | null>(null);
  const [terminalCloseRecoveryAvailable, setTerminalCloseRecoveryAvailable] = useState(false);
  const [terminalCloseRecoveryPending, setTerminalCloseRecoveryPending] = useState(false);
  const terminalActionStartedRef = useRef(false);
  const terminalActionRequestedRef = useRef(false);
  const terminalActionGenerationRef = useRef(0);
  const terminalCloseRecoveryPendingRef = useRef(false);
  const openAISettingsAfterHideRef = useRef(false);
  const activeTerminalActionRef = useRef<'attach' | 'hide' | 'close' | null>(null);
  const closePreemptionRequestedRef = useRef(false);
  const hideVisibilityRevisionRef = useRef(0);
  const lastFocusVisibilityRevisionRef = useRef(0);
  const aiTerminalGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const resultSessionRef = useRef<QueryEditorResultSessionSnapshot | null>(null);
  const queryResultWindowRef = useRef<DetachedQueryResultWindow | null>(null);
  const queryResultDirtyGenerationRef = useRef(0);
  const scheduleSyncRef = useRef<(includeResultSession?: boolean) => void>(() => undefined);
  const syncedSqlLogIdsRef = useRef<Set<string>>(new Set());
  const sqlLogsClearPendingRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncIncludesResultSessionRef = useRef(false);
  const hostStateRevisionRef = useRef(0);
  const actionRevisionRef = useRef(0);
  const actionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const processedHostEventIdsRef = useRef<Set<string>>(new Set());
  const previousHostAIContextsRef = useRef<unknown>({});
  const hostEventSequenceRef = useRef(0);
  const workbenchStateSourceRef = useRef<NativeDetachedStoreSnapshot>({});
  const syncedWorkbenchTabIdsRef = useRef<Set<string>>(new Set());
  const handleQueryResultDataChange = useCallback((rows: Array<Record<string, unknown>>) => {
    const resultWindow = queryResultWindowRef.current;
    if (!resultWindow) return;
    queryResultWindowRef.current = {
      ...resultWindow,
      result: { ...resultWindow.result, rows },
    };
    queryResultDirtyGenerationRef.current += 1;
    scheduleSyncRef.current(false);
  }, []);

  const themeMode = useStore((state) => state.theme);
  const uiVersion = useStore((state) => state.appearance.uiVersion);
  const fontSize = useStore((state) => state.fontSize);
  const uiScale = useStore((state) => state.uiScale);
  const shortcutOptions = useStore((state) => state.shortcutOptions);
  const [computedCustomThemeAntTokens, setComputedCustomThemeAntTokens] = useState<CustomThemeAntTokenSnapshot | null>(null);
  const effectiveThemeMode = customThemeOverride?.baseMode === 'dark'
    ? 'dark'
    : customThemeOverride?.baseMode === 'light'
      ? 'light'
      : themeMode;

  useLayoutEffect(() => {
    applyNativeDetachedDocumentAppearance(effectiveThemeMode, uiVersion, fontSize, uiScale);
  }, [effectiveThemeMode, fontSize, uiScale, uiVersion]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    return installGlobalImeCompositionTracking(
      window,
      typeof document === 'undefined' ? null : document,
    );
  }, []);

  useEffect(() => {
    const persist = (useStore as any).persist;
    if (typeof persist?.setOptions !== 'function') return;
    persist.setOptions({
      storage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
  }, []);

  useEffect(() => {
    let active = true;
    void client.load()
      .then((nextBootstrap) => {
        if (!active) return;
        const bootstrapActionRevision = Math.trunc(Number(nextBootstrap.actionRevision));
        actionRevisionRef.current = Number.isFinite(bootstrapActionRevision) && bootstrapActionRevision > 0
          ? bootstrapActionRevision
          : 0;
        setContentReady(false);
        setControllerEnabled(false);
        hydrateNativeDetachedStore(useStore, nextBootstrap.payload.storeState);
        setCustomThemeOverride(readNativeDetachedThemeContext(nextBootstrap.payload.storeState));
        queryResultWindowRef.current = nextBootstrap.payload.resultWindow ?? null;
        previousHostAIContextsRef.current = useStore.getState().aiContexts;
        workbenchStateSourceRef.current = buildNativeDetachedWorkbenchMutableStoreSnapshot(
          useStore.getState(),
        );
        syncedWorkbenchTabIdsRef.current = new Set(
          (useStore.getState().tabs || []).map((tab) => String(tab.id || '').trim()).filter(Boolean),
        );
        syncedSqlLogIdsRef.current = new Set(
          (useStore.getState().sqlLogs || [])
            .map((log) => String(log.id || '').trim())
            .filter(Boolean),
        );
        if (nextBootstrap.kind === 'workbench' && nextBootstrap.payload.tab) {
          resultSessionRef.current = nextBootstrap.payload.resultSession ?? null;
          if (nextBootstrap.payload.resultSession) {
            saveQueryEditorResultSession(
              nextBootstrap.payload.tab.id,
              nextBootstrap.payload.resultSession,
            );
          }
        }
        setBootstrap(nextBootstrap);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!bootstrap) return undefined;
    return EventsOn(
      NATIVE_DETACHED_WINDOW_COMMAND_EVENT,
      (command: NativeDetachedHostStateCommand) => {
        const themeContext = readNativeDetachedThemeContext(command?.payload?.storeState);
        if (themeContext !== undefined) {
          setCustomThemeOverride((current) => {
            const currentKey = current ? `${current.id}:${current.updatedAt}:${current.css}` : current;
            const nextKey = themeContext
              ? `${themeContext.id}:${themeContext.updatedAt}:${themeContext.css}`
              : themeContext;
            return currentKey === nextKey ? current : themeContext;
          });
        }
        const isCurrentAIWindow = bootstrap.kind === 'ai-chat'
          && String(command?.id || '') === bootstrap.id;
        const visibilityRevision = Math.trunc(Number(command?.payload?.visibilityRevision));
        if (isCurrentAIWindow && Number.isFinite(visibilityRevision) && visibilityRevision > 0) {
          if (
            command.action === 'hide'
            && visibilityRevision > lastFocusVisibilityRevisionRef.current
          ) {
            hideVisibilityRevisionRef.current = Math.max(
              hideVisibilityRevisionRef.current,
              visibilityRevision,
            );
          } else if (
            command.action === 'focus'
            && visibilityRevision > lastFocusVisibilityRevisionRef.current
          ) {
            lastFocusVisibilityRevisionRef.current = visibilityRevision;
            if (
              activeTerminalActionRef.current !== 'attach'
              && activeTerminalActionRef.current !== 'close'
              && !closePreemptionRequestedRef.current
              && visibilityRevision > hideVisibilityRevisionRef.current
            ) {
              // WindowHide can suspend the WebView before React commits the
              // terminal-action cleanup. A newer native focus is the resume
              // boundary, so invalidate the old hide and unlock the live tree.
              terminalActionGenerationRef.current += 1;
              terminalActionStartedRef.current = false;
              terminalActionRequestedRef.current = false;
              activeTerminalActionRef.current = null;
              openAISettingsAfterHideRef.current = false;
              hideVisibilityRevisionRef.current = 0;
              setTerminalCloseRecoveryAvailable(false);
              setTerminalAction((current) => current === 'hide' ? null : current);
            }
          }
        }
        hostStateRevisionRef.current = applyNativeDetachedHostStateCommand(
          useStore,
          bootstrap.id,
          hostStateRevisionRef.current,
          command,
          {
            processedEventIds: processedHostEventIdsRef.current,
            previousHostAIContextsRef,
            dispatchHostEvent: (hostEvent) => {
              if (typeof window === 'undefined') return;
              window.dispatchEvent(new CustomEvent(hostEvent.name, {
                detail: hostEvent.detail,
              }));
            },
          },
        );
      },
    );
  }, [bootstrap]);

  useEffect(() => {
    if (!bootstrap || typeof window === 'undefined' || !client.hostEvent) return undefined;
    const eventNames: NativeDetachedHostEventName[] = bootstrap.kind === 'ai-chat'
      ? [
          'gonavi:insert-sql',
          'gonavi:jvm-apply-ai-plan',
          'gonavi:jvm-apply-diagnostic-plan',
        ]
      : ['gonavi:ai:inject-prompt'];
    const forwardToHost = (event: Event) => {
      hostEventSequenceRef.current += 1;
      const hostEvent: NativeDetachedHostEvent = {
        id: `${bootstrap.id}:${Date.now()}:${hostEventSequenceRef.current}`,
        name: event.type as NativeDetachedHostEventName,
        detail: (event as CustomEvent<unknown>).detail,
      };
      void client.hostEvent?.({
        id: bootstrap.id,
        kind: bootstrap.kind,
        hostEvent,
      }).catch((error) => {
        console.warn('[Native Detached Window] Failed to forward event to host', error);
      });
    };
    eventNames.forEach((eventName) => window.addEventListener(eventName, forwardToHost));
    return () => {
      eventNames.forEach((eventName) => window.removeEventListener(eventName, forwardToHost));
    };
  }, [bootstrap, client]);

  useEffect(() => {
    if (!bootstrap || typeof window === 'undefined' || !client.hostEvent) return undefined;
    const platform = getShortcutPlatform(isMacLikePlatform());
    const binding = resolveShortcutBinding(shortcutOptions, 'toggleAIPanel', platform);
    if (!binding.enabled) return undefined;

    const handleToggleAIShortcut = (event: KeyboardEvent) => {
      if (!isShortcutMatch(event, binding.combo)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      hostEventSequenceRef.current += 1;
      void client.hostEvent?.({
        id: bootstrap.id,
        kind: bootstrap.kind,
        hostEvent: {
          id: `${bootstrap.id}:${Date.now()}:${hostEventSequenceRef.current}`,
          name: 'gonavi:shortcut:toggle-ai-panel',
        },
      }).catch((error) => {
        console.warn('[Native Detached Window] Failed to forward AI shortcut to host', error);
      });
    };
    const listenerOptions = { capture: true };
    window.addEventListener('keydown', handleToggleAIShortcut, listenerOptions);
    return () => window.removeEventListener('keydown', handleToggleAIShortcut, listenerOptions);
  }, [bootstrap, client, shortcutOptions]);

  useEffect(() => {
    if (!bootstrap || !contentMounted || !contentReady) return undefined;
    let active = true;
    void Promise.resolve(client.present?.())
      .then(() => waitForNativeDetachedContentPaint())
      .then(() => {
        if (!active) return undefined;
        return client.ready({ id: bootstrap.id, kind: bootstrap.kind }).then(() => {
          if (active) setControllerEnabled(true);
        });
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [bootstrap, client, contentMounted, contentReady]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.setAttribute('data-theme', effectiveThemeMode === 'dark' ? 'dark' : 'light');
    document.body.setAttribute('data-ui-version', uiVersion);
    document.body.style.color = effectiveThemeMode === 'dark' ? '#ffffff' : '#111827';
    document.body.style.fontSize = `${Math.max(10, Number(fontSize) || 14)}px`;
    document.documentElement.style.colorScheme = effectiveThemeMode === 'dark' ? 'dark' : 'light';
  }, [effectiveThemeMode, fontSize, uiVersion]);

  const readCurrentTab = useCallback((): TabData | undefined => {
    const bootstrapTab = bootstrap?.payload.tab;
    if (!bootstrapTab) return undefined;
    return resolveLiveQueryTab(
      useStore.getState().tabs.find((item) => item.id === bootstrapTab.id)
        || bootstrapTab,
    );
  }, [bootstrap]);

  const readUnsyncedSqlLogs = useCallback((): SqlLog[] => {
    const syncedIds = syncedSqlLogIdsRef.current;
    return (useStore.getState().sqlLogs || []).filter((log) => {
      const id = String(log.id || '').trim();
      return id !== '' && !syncedIds.has(id);
    });
  }, []);

  const markSqlLogsSynced = useCallback((logs: SqlLog[]): void => {
    for (const log of logs) {
      const id = String(log.id || '').trim();
      if (id) syncedSqlLogIdsRef.current.add(id);
    }
  }, []);

  const readWorkbenchSyncData = useCallback(() => {
    if (bootstrap?.kind !== 'workbench' && bootstrap?.kind !== 'query-result') {
      return {
        workbenchState: {},
        workbenchStateBase: {},
        openedTabs: [] as TabData[],
      };
    }
    const state = useStore.getState();
    const workbenchState = buildNativeDetachedChangedWorkbenchStoreSnapshot(
      state,
      workbenchStateSourceRef.current,
    );
    const workbenchStateBase = buildNativeDetachedStoreSnapshot(Object.fromEntries(
      Object.keys(workbenchState).map((key) => [key, workbenchStateSourceRef.current[key]]),
    ));
    return {
      workbenchState,
      workbenchStateBase,
      openedTabs: bootstrap.kind === 'workbench'
        ? resolveLiveQueryTabs(state.tabs.filter(
          (tab) => !syncedWorkbenchTabIdsRef.current.has(String(tab.id || '').trim()),
        ))
        : [],
    };
  }, [bootstrap?.kind]);

  const markWorkbenchStateSynced = useCallback((
    workbenchState: NativeDetachedStoreSnapshot,
    openedTabs: TabData[],
  ): void => {
    workbenchStateSourceRef.current = advanceNativeDetachedStoreSource(
      workbenchStateSourceRef.current,
      workbenchState,
    );
    for (const tab of openedTabs) {
      const id = String(tab.id || '').trim();
      if (id) syncedWorkbenchTabIdsRef.current.add(id);
    }
  }, []);

  const nextActionRevision = useCallback((): number => {
    actionRevisionRef.current += 1;
    return actionRevisionRef.current;
  }, []);

  const enqueueAction = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = actionQueueRef.current.catch(() => undefined).then(operation);
    actionQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const scheduleSync = useCallback((includeResultSession = false) => {
    if (!bootstrap || terminalAction) return;
    syncIncludesResultSessionRef.current = syncIncludesResultSessionRef.current || includeResultSession;
    if (syncTimerRef.current !== null) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void enqueueAction(async () => {
        const shouldIncludeResultSession = syncIncludesResultSessionRef.current;
        syncIncludesResultSessionRef.current = false;
        const newSqlLogs = readUnsyncedSqlLogs();
        const clearSqlLogs = sqlLogsClearPendingRef.current;
        const queryResultDirtyGeneration = queryResultDirtyGenerationRef.current;
        const queryResultChanged = queryResultDirtyGeneration > 0;
        const { workbenchState, workbenchStateBase, openedTabs } = readWorkbenchSyncData();
        if (
          bootstrap.kind === 'query-result'
          && newSqlLogs.length === 0
          && !clearSqlLogs
          && !queryResultChanged
          && Object.keys(workbenchState).length === 0
        ) return;
        await client.sync(buildActionPayload(
          bootstrap,
          readCurrentTab(),
          resultSessionRef.current,
          shouldIncludeResultSession,
          newSqlLogs,
          nextActionRevision(),
          workbenchState,
          workbenchStateBase,
          openedTabs,
          clearSqlLogs,
          queryResultWindowRef.current,
        ));
        if (
          queryResultChanged
          && queryResultDirtyGenerationRef.current === queryResultDirtyGeneration
        ) {
          queryResultDirtyGenerationRef.current = 0;
        }
        if (clearSqlLogs) {
          syncedSqlLogIdsRef.current.clear();
          sqlLogsClearPendingRef.current = false;
        }
        markSqlLogsSynced(newSqlLogs);
        markWorkbenchStateSynced(workbenchState, openedTabs);
      }).catch((error) => {
        console.warn('[Native Detached Window] Failed to sync tab state', error);
      });
    }, NATIVE_DETACHED_SYNC_DEBOUNCE_MS);
  }, [
    bootstrap,
    client,
    enqueueAction,
    markSqlLogsSynced,
    markWorkbenchStateSynced,
    nextActionRevision,
    readCurrentTab,
    readUnsyncedSqlLogs,
    readWorkbenchSyncData,
    terminalAction,
  ]);
  scheduleSyncRef.current = scheduleSync;

  useEffect(() => {
    if (!bootstrap) {
      return undefined;
    }
    const unsubscribeStore = useStore.subscribe((state, previousState) => {
      if (
        (previousState?.sqlLogs?.length || 0) > 0
        && (state.sqlLogs?.length || 0) === 0
      ) {
        sqlLogsClearPendingRef.current = true;
      }
      scheduleSync(false);
    });
    const unsubscribeResultSession = bootstrap.kind === 'workbench' && bootstrap.payload.tab
      ? subscribeQueryEditorResultSession(
          bootstrap.payload.tab.id,
          (snapshot) => {
            // QueryEditor consumes the initial cache entry during mount. Keep
            // the last non-null snapshot for the final attach action.
            if (snapshot) {
              resultSessionRef.current = snapshot;
              scheduleSync(false);
            }
          },
        )
      : () => undefined;
    const unsubscribeQueryDrafts = bootstrap.kind === 'workbench'
      ? subscribeQueryTabDraftChanges(() => scheduleSync(false))
      : () => undefined;
    return () => {
      unsubscribeStore();
      unsubscribeResultSession();
      unsubscribeQueryDrafts();
      if (syncTimerRef.current !== null) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [bootstrap, scheduleSync]);

  const requestTerminalAction = useCallback((
    action: 'attach' | 'hide' | 'close',
    visibilityRevision = 0,
  ) => {
    if (!bootstrap) return;
    if (action !== 'hide') openAISettingsAfterHideRef.current = false;
    const normalizedVisibilityRevision = Math.trunc(Number(visibilityRevision));
    if (
      action === 'hide'
      && Number.isFinite(normalizedVisibilityRevision)
      && normalizedVisibilityRevision > 0
      && normalizedVisibilityRevision <= lastFocusVisibilityRevisionRef.current
    ) {
      return;
    }
    if (terminalActionRequestedRef.current) {
      if (
        action === 'hide'
        && activeTerminalActionRef.current === 'hide'
        && Number.isFinite(normalizedVisibilityRevision)
        && normalizedVisibilityRevision > 0
      ) {
        hideVisibilityRevisionRef.current = Math.max(
          hideVisibilityRevisionRef.current,
          normalizedVisibilityRevision,
        );
      }
      if (action === 'close' && activeTerminalActionRef.current === 'hide') {
        closePreemptionRequestedRef.current = true;
      }
      return;
    }
    if (action === 'hide' && bootstrap.kind !== 'ai-chat') return;
    terminalActionGenerationRef.current += 1;
    setTerminalCloseRecoveryAvailable(false);
    terminalActionRequestedRef.current = true;
    activeTerminalActionRef.current = action;
    closePreemptionRequestedRef.current = false;
    hideVisibilityRevisionRef.current = action === 'hide'
      && Number.isFinite(normalizedVisibilityRevision)
      && normalizedVisibilityRevision > 0
      ? normalizedVisibilityRevision
      : 0;
    if (syncTimerRef.current !== null) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (bootstrap.kind !== 'ai-chat') setContentMounted(false);
    setTerminalAction(action);
  }, [bootstrap]);

  const requestOpenAISettings = useCallback(() => {
    if (
      !bootstrap
      || bootstrap.kind !== 'ai-chat'
      || terminalActionRequestedRef.current
    ) return;
    openAISettingsAfterHideRef.current = true;
    requestTerminalAction('hide');
  }, [bootstrap, requestTerminalAction]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleGracefulCloseRequest = () => requestTerminalAction('close');
    const handleHideRequest = (event: Event) => requestTerminalAction(
      'hide',
      Number((event as CustomEvent<{ visibilityRevision?: unknown }>).detail?.visibilityRevision),
    );
    window.addEventListener(
      'gonavi:native-detached-request-close',
      handleGracefulCloseRequest as EventListener,
    );
    window.addEventListener(
      'gonavi:native-detached-request-hide',
      handleHideRequest as EventListener,
    );
    return () => {
      window.removeEventListener(
        'gonavi:native-detached-request-close',
        handleGracefulCloseRequest as EventListener,
      );
      window.removeEventListener(
        'gonavi:native-detached-request-hide',
        handleHideRequest as EventListener,
      );
    };
  }, [requestTerminalAction]);

  useEffect(() => {
    if (
      !bootstrap
      || !terminalAction
      || terminalActionStartedRef.current
      || !terminalActionRequestedRef.current
      || activeTerminalActionRef.current !== terminalAction
      || (bootstrap.kind !== 'ai-chat' && contentMounted)
    ) {
      return;
    }
    terminalActionStartedRef.current = true;
    const terminalActionGeneration = terminalActionGenerationRef.current;
    const isCurrentTerminalAction = () => (
      terminalActionGenerationRef.current === terminalActionGeneration
    );

    // Workbench content has unmounted before this effect runs, so QueryEditor
    // has published its final result session to the cache.
    const currentSession = bootstrap.payload.tab
      ? peekQueryEditorResultSession(bootstrap.payload.tab.id) || resultSessionRef.current
      : null;
    void (async () => {
      let actionToRun = terminalAction;
      let closeActionSubmitted = false;
      const submitPreemptingClose = async () => {
        const closeWorkbench = readWorkbenchSyncData();
        await client.close(buildActionPayload(
          bootstrap,
          readCurrentTab(),
          currentSession,
          false,
          readUnsyncedSqlLogs(),
          nextActionRevision(),
          closeWorkbench.workbenchState,
          closeWorkbench.workbenchStateBase,
          closeWorkbench.openedTabs,
          sqlLogsClearPendingRef.current,
          queryResultWindowRef.current,
        ));
        closeActionSubmitted = true;
        actionToRun = 'close';
      };
      const rollbackTerminalAction = async () => {
        setTerminalCloseRecoveryAvailable(false);
        let parentCancelError: unknown;
        let parentCancelSucceeded = !client.cancelCloseRequest;
        for (
          let attempt = 0;
          client.cancelCloseRequest && attempt < NATIVE_DETACHED_CANCEL_CLOSE_ATTEMPTS;
          attempt += 1
        ) {
          const cancelWorkbench = readWorkbenchSyncData();
          const cancelPayload = {
            ...buildActionPayload(
              bootstrap,
              readCurrentTab(),
              currentSession,
              false,
              readUnsyncedSqlLogs(),
              nextActionRevision(),
              cancelWorkbench.workbenchState,
              cancelWorkbench.workbenchStateBase,
              cancelWorkbench.openedTabs,
              sqlLogsClearPendingRef.current,
              queryResultWindowRef.current,
            ),
            rollbackAction: actionToRun,
          } satisfies NativeDetachedWindowActionPayload;
          try {
            await client.cancelCloseRequest(cancelPayload);
            parentCancelSucceeded = true;
            break;
          } catch (error) {
            parentCancelError = error;
          }
        }
        if (!parentCancelSucceeded) {
          console.error(
            '[Native Detached Window] Failed to cancel parent close fallback',
            parentCancelError,
          );
        }
        if (!isCurrentTerminalAction()) return;
        let localCancelError: unknown;
        let localCancelSucceeded = false;
        try {
          await client.cancelClose?.();
          localCancelSucceeded = true;
        } catch (error) {
          localCancelError = error;
          console.error(
            '[Native Detached Window] Failed to cancel local close fallback',
            localCancelError,
          );
        }
        if (!isCurrentTerminalAction()) return;
        if (!parentCancelSucceeded || !localCancelSucceeded) {
          try {
            await client.closeCurrentWindow();
          } catch (convergenceError) {
            console.error(
              '[Native Detached Window] Failed to converge after close rollback',
              convergenceError,
            );
            setTerminalCloseRecoveryAvailable(true);
          }
          return;
        }
        terminalActionStartedRef.current = false;
        terminalActionRequestedRef.current = false;
        activeTerminalActionRef.current = null;
        closePreemptionRequestedRef.current = false;
        hideVisibilityRevisionRef.current = 0;
        setTerminalCloseRecoveryAvailable(false);
        setTerminalAction(null);
        setContentMounted(true);
      };
      try {
        await actionQueueRef.current;
        if (!isCurrentTerminalAction()) return;
        if (bootstrap.kind === 'ai-chat') {
          const canTerminate = await aiTerminalGuardRef.current?.();
          if (!isCurrentTerminalAction()) return;
          if (canTerminate === false) {
            throw new Error('AI stream did not stop before the detached window handoff');
          }
          await flushAIChatSessionPersistence();
          if (!isCurrentTerminalAction()) return;
        }
        actionToRun = closePreemptionRequestedRef.current ? 'close' : terminalAction;
        if (actionToRun === 'attach' && bootstrap.kind === 'workbench') {
          const finalSqlLogs = readUnsyncedSqlLogs();
          const clearSqlLogs = sqlLogsClearPendingRef.current;
          const finalWorkbench = readWorkbenchSyncData();
          try {
            await client.sync(buildActionPayload(
              bootstrap,
              readCurrentTab(),
              currentSession,
              true,
              finalSqlLogs,
              nextActionRevision(),
              finalWorkbench.workbenchState,
              finalWorkbench.workbenchStateBase,
              finalWorkbench.openedTabs,
              clearSqlLogs,
              queryResultWindowRef.current,
            ));
            if (clearSqlLogs) {
              syncedSqlLogIdsRef.current.clear();
              sqlLogsClearPendingRef.current = false;
            }
            markSqlLogsSynced(finalSqlLogs);
            markWorkbenchStateSynced(
              finalWorkbench.workbenchState,
              finalWorkbench.openedTabs,
            );
          } catch (error) {
            // The attach request carries the same final tab/session payload, so
            // a failed best-effort sync must not prevent the user from restoring.
            console.warn('[Native Detached Window] Final sync before attach failed', error);
          }
        }
        const terminalWorkbench = readWorkbenchSyncData();
        const payload = buildActionPayload(
          bootstrap,
          readCurrentTab(),
          currentSession,
          actionToRun === 'attach',
          readUnsyncedSqlLogs(),
          nextActionRevision(),
          terminalWorkbench.workbenchState,
          terminalWorkbench.workbenchStateBase,
          terminalWorkbench.openedTabs,
          sqlLogsClearPendingRef.current,
          queryResultWindowRef.current,
        );
        if (actionToRun === 'attach') {
          await client.attach(payload);
        } else if (actionToRun === 'hide') {
          let visibilityRevision = hideVisibilityRevisionRef.current;
          if (visibilityRevision > 0) {
            await client.sync(payload);
            if (!isCurrentTerminalAction()) return;
          } else {
            if (!client.hide) throw new Error('Native detached hide action is unavailable');
            visibilityRevision = await client.hide(payload);
            if (!isCurrentTerminalAction()) return;
            hideVisibilityRevisionRef.current = Math.max(
              hideVisibilityRevisionRef.current,
              visibilityRevision,
            );
          }
          if (closePreemptionRequestedRef.current) {
            await submitPreemptingClose();
          } else if (openAISettingsAfterHideRef.current) {
            await client.openAISettings(visibilityRevision);
          } else {
            if (!client.hideCurrentWindow) {
              throw new Error('Native detached hide control is unavailable');
            }
            await client.hideCurrentWindow(visibilityRevision);
            if (!isCurrentTerminalAction()) return;
            if (closePreemptionRequestedRef.current) {
              await submitPreemptingClose();
            }
          }
        } else {
          await client.close(payload);
          closeActionSubmitted = true;
        }
      } catch (error) {
        if (!isCurrentTerminalAction()) return;
        console.error(`[Native Detached Window] Failed to ${actionToRun}`, error);
        if (closePreemptionRequestedRef.current && !closeActionSubmitted) {
          try {
            await submitPreemptingClose();
          } catch (closeError) {
            console.error('[Native Detached Window] Failed to continue with requested close', closeError);
          }
        }
        if (
          actionToRun === 'hide'
          && !closeActionSubmitted
          && !openAISettingsAfterHideRef.current
        ) {
          const visibilityRevision = hideVisibilityRevisionRef.current;
          if (visibilityRevision > 0) {
            try {
              await client.hideCurrentWindow?.(visibilityRevision);
              if (!isCurrentTerminalAction()) return;
            } catch (localHideError) {
              if (!isCurrentTerminalAction()) return;
              console.error('[Native Detached Window] Failed to apply requested hide', localHideError);
            }
          }
          if (closePreemptionRequestedRef.current && !closeActionSubmitted) {
            try {
              await submitPreemptingClose();
            } catch (closeError) {
              console.error('[Native Detached Window] Failed to continue with requested close', closeError);
            }
          }
        }
        if (!isCurrentTerminalAction()) return;
        if (actionToRun === 'hide' && !closeActionSubmitted) {
          openAISettingsAfterHideRef.current = false;
          terminalActionStartedRef.current = false;
          terminalActionRequestedRef.current = false;
          activeTerminalActionRef.current = null;
          closePreemptionRequestedRef.current = false;
          hideVisibilityRevisionRef.current = 0;
          setTerminalCloseRecoveryAvailable(false);
          setTerminalAction(null);
          return;
        }
        if (!closeActionSubmitted) {
          await rollbackTerminalAction();
          return;
        }
      }
      if (!isCurrentTerminalAction()) return;
      if (actionToRun === 'hide') {
        openAISettingsAfterHideRef.current = false;
        terminalActionStartedRef.current = false;
        terminalActionRequestedRef.current = false;
        activeTerminalActionRef.current = null;
        closePreemptionRequestedRef.current = false;
        hideVisibilityRevisionRef.current = 0;
        setTerminalCloseRecoveryAvailable(false);
        setTerminalAction(null);
        return;
      }
      try {
        await client.closeCurrentWindow();
      } catch (error) {
        console.error('[Native Detached Window] Failed to close native window', error);
        await rollbackTerminalAction();
      }
    })();
  }, [
    bootstrap,
    client,
    contentMounted,
    markSqlLogsSynced,
    markWorkbenchStateSynced,
    nextActionRevision,
    readCurrentTab,
    readUnsyncedSqlLogs,
    readWorkbenchSyncData,
    terminalAction,
  ]);

  const retryTerminalClose = useCallback(() => {
    if (!terminalCloseRecoveryAvailable || terminalCloseRecoveryPendingRef.current) return;
    terminalCloseRecoveryPendingRef.current = true;
    setTerminalCloseRecoveryPending(true);
    void client.closeCurrentWindow()
      .then(() => {
        setTerminalCloseRecoveryAvailable(false);
      })
      .catch((error) => {
        console.error('[Native Detached Window] Failed to retry native window close', error);
      })
      .finally(() => {
        terminalCloseRecoveryPendingRef.current = false;
        setTerminalCloseRecoveryPending(false);
      });
  }, [client, terminalCloseRecoveryAvailable]);

  const requestWindowClose = useCallback(() => {
    requestTerminalAction(bootstrap?.kind === 'ai-chat' ? 'hide' : 'close');
  }, [bootstrap?.kind, requestTerminalAction]);

  const chromeLabels = useMemo(() => ({
    attach: bootstrap?.kind === 'workbench'
      ? translate('tab_manager.detached.restore')
      : bootstrap?.kind === 'ai-chat'
        ? translate('ai_chat.detached.action.dock')
        : translate('query_editor.results_panel.detached.restore'),
    close: bootstrap?.kind === 'workbench'
      ? translate('tab_manager.detached.close')
      : bootstrap?.kind === 'ai-chat'
        ? translate('ai_chat.header.tooltip.close')
        : translate('query_editor.results_panel.detached.close'),
  }), [bootstrap?.kind, translate]);

  const isDark = effectiveThemeMode === 'dark';
  const customThemeStyleContextKey = `${effectiveThemeMode}:${uiVersion}`;
  const customThemeAntTokens = computedCustomThemeAntTokens?.contextKey === customThemeStyleContextKey
    ? computedCustomThemeAntTokens.tokens
    : {};
  const v2PrimaryColor = customThemeAntTokens.primary ?? (isDark ? '#22c55e' : '#16a34a');
  const v2PrimaryContrastColor = customThemeAntTokens.primaryContrast ?? '#ffffff';
  const v2PrimaryHoverColor = customThemeAntTokens.primaryHover ?? (isDark ? '#4ade80' : '#15803d');
  const v2PrimaryActiveColor = customThemeAntTokens.primaryActive ?? (isDark ? '#16a34a' : '#166534');
  const v2PrimaryBgColor = customThemeAntTokens.primaryBg ?? (isDark ? 'rgba(34, 197, 94, 0.20)' : '#dcfce7');
  const v2PrimaryBgHoverColor = customThemeAntTokens.primaryBgHover ?? (isDark ? 'rgba(34, 197, 94, 0.28)' : '#bbf7d0');
  const v2PrimaryBorderColor = customThemeAntTokens.primaryBorder ?? (isDark ? 'rgba(34, 197, 94, 0.42)' : '#86efac');
  const v2PrimaryBorderHoverColor = customThemeAntTokens.primaryBorderHover ?? (isDark ? 'rgba(74, 222, 128, 0.58)' : '#4ade80');
  const v2ControlActiveBg = customThemeAntTokens.controlActiveBg ?? (isDark ? 'rgba(34, 197, 94, 0.16)' : 'rgba(34, 197, 94, 0.10)');
  const v2ControlActiveHoverBg = customThemeAntTokens.controlActiveHoverBg ?? (isDark ? 'rgba(34, 197, 94, 0.24)' : 'rgba(34, 197, 94, 0.16)');
  const v2ControlOutline = customThemeAntTokens.controlOutline ?? (isDark ? 'rgba(34, 197, 94, 0.42)' : 'rgba(22, 163, 74, 0.22)');
  const componentSize = uiScale <= 0.92 ? 'small' : (uiScale >= 1.12 ? 'large' : 'middle');
  return (
    <>
      <CustomThemeStyleHost
        contextKey={customThemeStyleContextKey}
        onAntTokensChange={setComputedCustomThemeAntTokens}
        themeOverride={customThemeOverride}
      />
      <ConfigProvider
        locale={getAntdLocale(i18n?.language ?? 'en-US')}
        componentSize={componentSize}
        theme={{
          algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            fontSize: Math.max(10, Number(fontSize) || 14),
            zIndexPopupBase: APP_OVERLAY_Z_INDEX_BASE,
            ...(uiVersion === 'v2' && customThemeAntTokens.bgContainer ? {
              colorBgContainer: customThemeAntTokens.bgContainer,
            } : {}),
            ...(uiVersion === 'v2' && customThemeAntTokens.bgElevated ? {
              colorBgElevated: customThemeAntTokens.bgElevated,
            } : {}),
            ...(uiVersion === 'v2' && customThemeAntTokens.fillAlter ? {
              colorFillAlter: customThemeAntTokens.fillAlter,
            } : {}),
            ...(uiVersion === 'v2' && customThemeAntTokens.textPrimary ? {
              colorText: customThemeAntTokens.textPrimary,
            } : {}),
            ...(uiVersion === 'v2' && customThemeAntTokens.textSecondary ? {
              colorTextSecondary: customThemeAntTokens.textSecondary,
            } : {}),
            ...(uiVersion === 'v2' && customThemeAntTokens.border ? {
              colorBorder: customThemeAntTokens.border,
              colorBorderSecondary: customThemeAntTokens.border,
            } : {}),
            colorPrimary: uiVersion === 'v2'
              ? v2PrimaryColor
              : (isDark ? '#f6c453' : '#1677ff'),
            colorTextLightSolid: uiVersion === 'v2' ? v2PrimaryContrastColor : '#ffffff',
            colorPrimaryHover: uiVersion === 'v2' ? v2PrimaryHoverColor : (isDark ? '#ffd666' : '#4096ff'),
            colorPrimaryActive: uiVersion === 'v2' ? v2PrimaryActiveColor : (isDark ? '#d8a93b' : '#0958d9'),
            colorInfo: uiVersion === 'v2'
              ? (customThemeAntTokens.info ?? v2PrimaryColor)
              : (isDark ? '#f6c453' : '#1677ff'),
            colorPrimaryBg: uiVersion === 'v2' ? v2PrimaryBgColor : (isDark ? 'rgba(246, 196, 83, 0.22)' : '#e6f4ff'),
            colorPrimaryBgHover: uiVersion === 'v2' ? v2PrimaryBgHoverColor : (isDark ? 'rgba(246, 196, 83, 0.30)' : '#bae0ff'),
            colorPrimaryBorder: uiVersion === 'v2' ? v2PrimaryBorderColor : (isDark ? 'rgba(246, 196, 83, 0.45)' : '#91caff'),
            colorPrimaryBorderHover: uiVersion === 'v2' ? v2PrimaryBorderHoverColor : (isDark ? 'rgba(246, 196, 83, 0.60)' : '#69b1ff'),
            controlItemBgActive: uiVersion === 'v2' ? v2ControlActiveBg : (isDark ? 'rgba(246, 196, 83, 0.20)' : 'rgba(22, 119, 255, 0.12)'),
            controlItemBgActiveHover: uiVersion === 'v2' ? v2ControlActiveHoverBg : (isDark ? 'rgba(246, 196, 83, 0.28)' : 'rgba(22, 119, 255, 0.18)'),
            controlOutline: uiVersion === 'v2' ? v2ControlOutline : (isDark ? 'rgba(246, 196, 83, 0.50)' : 'rgba(5, 145, 255, 0.24)'),
          },
        }}
      >
      {bootstrap && controllerEnabled ? (
        <React.Suspense fallback={null}>
          <NativeDetachedWindowController currentWindowId={bootstrap.id} />
        </React.Suspense>
      ) : null}
      <div
        className="gn-native-detached-window"
        data-kind={bootstrap?.kind || 'loading'}
      >
        <style>{`
        .gn-native-detached-window {
          position: relative;
          width: 100%;
          height: 100%;
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: ${isDark ? '#f3f4f6' : '#111827'};
          background: ${isDark ? 'var(--gn-bg-app, #0c0e12)' : 'var(--gn-bg-app, #f6f6f4)'};
        }
        .gn-native-detached-chrome {
          flex: 0 0 36px;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 6px 0 12px;
          border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)'};
          background: ${isDark ? 'var(--gn-bg-chrome, #14171c)' : 'var(--gn-bg-chrome, #ececea)'};
          user-select: none;
          --wails-draggable: drag;
        }
        .gn-native-detached-title {
          min-width: 0;
          flex: 1 1 auto;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 600;
        }
        .gn-native-detached-actions {
          flex: 0 0 auto;
          display: inline-flex;
          gap: 2px;
          --wails-draggable: no-drag;
        }
        .gn-native-detached-close-recovery {
          position: absolute;
          top: 6px;
          right: 6px;
          z-index: ${APP_OVERLAY_Z_INDEX_BASE + 1};
          --wails-draggable: no-drag;
        }
        .gn-native-detached-body {
          flex: 1 1 auto;
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: ${isDark ? 'var(--gn-bg-panel, #161a21)' : 'var(--gn-bg-panel, #ffffff)'};
        }
        .gn-native-detached-loading,
        .gn-native-detached-error {
          flex: 1 1 auto;
          display: grid;
          place-items: center;
          min-width: 0;
          min-height: 0;
          padding: 24px;
        }
        .gn-native-detached-error {
          color: ${isDark ? '#fca5a5' : '#b91c1c'};
          overflow: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .gn-native-detached-message {
          flex: 1 1 auto;
          width: 100%;
          min-width: 0;
          min-height: 0;
          box-sizing: border-box;
          margin: 0;
          padding: 12px;
          border: 0;
          resize: none;
          outline: none;
          color: inherit;
          background: transparent;
          font-family: var(--gn-font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
          font-size: 12px;
          line-height: 1.5;
        }
        .gn-native-detached-ai-chat {
          flex: 1 1 auto;
          min-width: 0;
          min-height: 0;
          display: flex;
          overflow: hidden;
        }
        .gn-native-detached-ai-chat .ai-chat-panel {
          width: 100% !important;
          height: 100%;
          min-width: 0;
          border-left: 0 !important;
        }
        .gn-native-detached-ai-chat .ai-resize-handle {
          display: none !important;
        }
        .gn-native-detached-ai-chat .ai-chat-header {
          cursor: move;
          user-select: none;
          --wails-draggable: drag;
        }
        .gn-native-detached-ai-chat .ai-chat-header button,
        .gn-native-detached-ai-chat .ai-chat-header a,
        .gn-native-detached-ai-chat .ai-chat-header input,
        .gn-native-detached-ai-chat .ai-chat-header textarea,
        .gn-native-detached-ai-chat .ai-chat-header-right,
        .gn-native-detached-ai-chat .gn-v2-ai-mode-tabs {
          --wails-draggable: no-drag;
        }
        `}</style>
        {terminalCloseRecoveryAvailable ? (
          <Tooltip title={chromeLabels.close}>
            <Button
              className="gn-native-detached-close-recovery"
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label={chromeLabels.close}
              data-native-close-recovery
              loading={terminalCloseRecoveryPending}
              onClick={retryTerminalClose}
            />
          </Tooltip>
        ) : null}
        {bootstrap?.kind !== 'ai-chat' ? <div className="gn-native-detached-chrome">
          <div className="gn-native-detached-title" title={bootstrap?.title || ''}>
            {bootstrap?.title || ''}
          </div>
          <div className="gn-native-detached-actions">
            <Tooltip title={chromeLabels.attach}>
              <Button
                type="text"
                size="small"
                icon={<CompressOutlined />}
                aria-label={chromeLabels.attach}
                disabled={!bootstrap || Boolean(terminalAction)}
                onClick={() => requestTerminalAction('attach')}
              />
            </Tooltip>
            <Tooltip title={chromeLabels.close}>
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                aria-label={chromeLabels.close}
                disabled={!bootstrap || Boolean(terminalAction)}
                onClick={requestWindowClose}
              />
            </Tooltip>
          </div>
        </div> : null}
        <div className="gn-native-detached-body">
          {loadError ? (
            <div className="gn-native-detached-error" role="alert">{loadError}</div>
          ) : !bootstrap ? (
            <div className="gn-native-detached-loading"><Spin /></div>
          ) : contentMounted ? (
            <React.Suspense
              fallback={<div className="gn-native-detached-loading"><Spin /></div>}
            >
              <NativeDetachedWindowContent
                bootstrap={bootstrap}
                themeModeOverride={effectiveThemeMode}
                onContentReady={markContentReady}
                onAttach={() => requestTerminalAction('attach')}
                onClose={requestWindowClose}
                onOpenSettings={requestOpenAISettings}
                onRegisterAITerminalGuard={(guard) => {
                  aiTerminalGuardRef.current = guard;
                }}
                interactionDisabled={Boolean(terminalAction)}
                onQueryResultDataChange={handleQueryResultDataChange}
              />
            </React.Suspense>
          ) : null}
        </div>
      </div>
      </ConfigProvider>
    </>
  );
};

export default NativeDetachedWindowApp;
