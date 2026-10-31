import {
  PluginList, PluginInspect, PluginInstall, PluginReplace, PluginSetEnabled, PluginRemove,
  PluginInvoke, PluginOpenWindow, PluginRuntimeInfo,
  PluginRemoteInspect, PluginRemoteInstall, PluginRemoteCancelInspection,
  PluginRunConnectionAction, PluginUpdateWindowPreferences,
} from '../../wailsjs/go/app/App';
import { pluginResult, ignoreResult } from './apiResult';
import { decodeStatuses, decodeStatus, decodeInspection, decodeRuntime, decodeRemoteInspection } from './decode';
import { boundedJSON } from './jsonBoundary';
import type { JSONValue } from './types';

// The generated module is the only host transport. No window.go reflection or mock production fallback.
export const pluginAPI = {
  list: () => pluginResult(PluginList(), decodeStatuses),
  runtimeInfo: () => pluginResult(PluginRuntimeInfo(), decodeRuntime),
  inspect: (path: string) => pluginResult(PluginInspect(path), decodeInspection),
  install: (path: string, digest: string, trusted: boolean) => pluginResult(PluginInstall(path, digest, trusted), decodeStatus),
  replace: (path: string, digest: string, trusted: boolean) => pluginResult(PluginReplace(path, digest, trusted), decodeStatus),
  remoteInspect: (spec: string) => pluginResult(PluginRemoteInspect(spec), decodeRemoteInspection),
  remoteInstall: (digest: string, trusted: boolean, approvalToken: string) => pluginResult(PluginRemoteInstall(digest, trusted, approvalToken), decodeStatus),
  remoteCancelInspection: (approvalToken: string) => pluginResult(PluginRemoteCancelInspection(approvalToken), ignoreResult),
  setEnabled: (id: string, enabled: boolean) => pluginResult(PluginSetEnabled(id, enabled), decodeStatus),
  remove: (id: string, purge: boolean) => pluginResult(PluginRemove(id, purge), ignoreResult),
  invoke: (id: string, command: string, args: JSONValue) => pluginResult(PluginInvoke(id, command, JSON.stringify(boundedJSON(args))), (data) => boundedJSON(data ?? null)),
  updateWindowPreferences: (json: string) => pluginResult(PluginUpdateWindowPreferences(json), ignoreResult),
  openWindow: (id: string, locale: string, theme: string) => pluginResult(PluginOpenWindow(id, locale, theme), ignoreResult),
  runConnectionAction: (pluginID: string, actionID: string, connectionID: string, database: string, collection: string) => pluginResult(
    PluginRunConnectionAction(pluginID, actionID, connectionID, database, collection),
    (data) => data as JSONValue,
  ),
};
