import type { TabData } from '../types';
import type { DetachedQueryResultWindow } from './detachedWindow';
import type { QueryEditorResultSessionSnapshot } from './queryEditorResultSessionCache';
import { type CustomThemeDefinition, sanitizeCustomThemeDefinition } from './customTheme';

export const NATIVE_DETACHED_BOOTSTRAP_URL = '/__gonavi/detached/bootstrap';
export const NATIVE_DETACHED_ACTION_URL = '/__gonavi/detached/action';

export const NATIVE_DETACHED_WINDOW_COMMAND_EVENT = 'gonavi:native-detached-command';
export const NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT = 'gonavi:redetach-query-result';

export const NATIVE_DETACHED_HOST_EVENTS_KEY = '__gonaviNativeHostEvents';
/** Reserved snapshot key; it is consumed by the detached document, not hydrated into Zustand. */
export const NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY = '__gonaviNativeCustomThemeContext';

export type NativeDetachedThemeContext = CustomThemeDefinition | null;

/**
 * Read a host-owned custom theme from a bootstrap or host-state snapshot.
 * An absent key means an older host did not provide the context; an explicit
 * null means the host intentionally has no active custom theme.
 */
export const readNativeDetachedThemeContext = (
  snapshot: object | null | undefined,
): NativeDetachedThemeContext | undefined => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
  const source = snapshot as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY)) {
    return undefined;
  }
  const raw = source[NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY];
  if (raw === null) return null;
  return sanitizeCustomThemeDefinition(raw);
};

export const withNativeDetachedThemeContext = (
  storeState: NativeDetachedStoreSnapshot,
  themeContext: NativeDetachedThemeContext | undefined,
): NativeDetachedStoreSnapshot => {
  if (themeContext === undefined) return storeState;
  return {
    ...storeState,
    [NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]: themeContext,
  };
};

export const NATIVE_DETACHED_HOST_EVENT_NAMES = [
  'gonavi:ai:inject-prompt',
  'gonavi:ai:config-changed',
  'gonavi:ai:provider-changed',
  'gonavi:locate-sidebar-object',
  'gonavi:insert-sql',
  'gonavi:insert-sql-to-tab',
  'gonavi:jvm-apply-ai-plan',
  'gonavi:jvm-apply-diagnostic-plan',
  'gonavi:open-download-source-settings',
  'gonavi:open-global-proxy-settings',
  'gonavi:shortcut:toggle-ai-panel',
] as const;

export type NativeDetachedHostEventName = typeof NATIVE_DETACHED_HOST_EVENT_NAMES[number];

export interface NativeDetachedHostEvent {
  id: string;
  name: NativeDetachedHostEventName;
  detail?: unknown;
}

export type NativeDetachedWindowKind = 'workbench' | 'query-result' | 'ai-chat';
export type NativeDetachedWindowAction =
  | 'ready'
  | 'sync'
  | 'attach'
  | 'hide'
  | 'close'
  | 'cancel-close'
  | 'open-ai-settings'
  | 'host-event';
export type NativeDetachedStoreSnapshot = Record<string, unknown>;

export interface NativeDetachedWindowPayload {
  storeState: NativeDetachedStoreSnapshot;
  tab?: TabData;
  resultWindow?: DetachedQueryResultWindow;
  resultSession?: QueryEditorResultSessionSnapshot | null;
}

export interface NativeDetachedWindowBootstrap {
  id: string;
  kind: NativeDetachedWindowKind;
  title: string;
  payload: NativeDetachedWindowPayload;
  actionRevision?: number;
}

export interface NativeDetachedWindowActionPayload {
  id: string;
  kind: NativeDetachedWindowKind;
  providerId?: string;
  revision?: number;
  rollbackAction?: 'attach' | 'hide' | 'close';
  storeState?: NativeDetachedStoreSnapshot;
  tab?: TabData;
  resultWindow?: DetachedQueryResultWindow;
  resultSession?: QueryEditorResultSessionSnapshot | null;
  hostEvent?: NativeDetachedHostEvent;
  openedTabs?: TabData[];
  workbenchState?: NativeDetachedStoreSnapshot;
  workbenchStateBase?: NativeDetachedStoreSnapshot;
  clearSqlLogs?: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface NativeDetachedWindowActionRequest {
  action: NativeDetachedWindowAction;
  payload: NativeDetachedWindowActionPayload;
}

export interface NativeDetachedWindowActionResult {
  success: boolean;
  applied?: boolean;
  message?: string;
  id?: string;
  visibilityRevision?: number;
}

export interface NativeDetachedHostStateCommand {
  id: string;
  action: 'sync-host-state' | string;
  payload?: {
    revision?: number;
    visibilityRevision?: number;
    storeState?: NativeDetachedStoreSnapshot;
  };
}

export type FetchLike = typeof fetch;

export type StoreApiLike<TState extends object> = {
  getState: () => TState;
  setState: (nextState: TState, replace?: boolean) => void;
};
