export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type PluginState = 'disabled' | 'starting' | 'running' | 'stopping' | 'faulted' | 'blocked';
export interface PluginCommand {
  id: string;
  title: string;
  description?: string;
  inputSchema?: JSONValue;
  effect?: 'read' | 'write' | 'unknown';
}
export interface UINode {
  type: 'text' | 'alert' | 'column' | 'row' | 'button' | 'table';
  text?: string;
  title?: string;
  children?: UINode[];
  command?: string;
  arguments?: JSONValue;
  columns?: { key: string; title: string }[];
  rows?: Record<string, JSONValue>[];
}
export interface PluginPanel {
  id: string;
  title: string;
  body?: unknown;
  html?: { source: string };
}
export interface PluginPage {
  id: string;
  title: string;
  body?: unknown;
  html?: { source: string };
}
export interface PluginNavigation {
  id: string;
  title: string;
  /** `page` opens the declared page in a tab; `window` opens the manifest window. */
  target?: 'page' | 'window';
  page?: string;
  location: 'tools' | 'statusbar';
  order?: number;
}
export interface PluginManifest {
  schemaVersion: number;
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  icon?: string;
  minHostVersion?: string;
  permissions: string[];
  permissionNotes?: Record<string, string>;
  requires?: { id: string; minVersion?: string; optional?: boolean }[];
  contributes?: { commands?: PluginCommand[]; panels?: PluginPanel[]; dataSources?: { id: string; name: string; dialect: string; command: string; defaultPort?: number; readOnly: boolean }[]; aiProviders?: { id: string; name: string; command: string; icon?: string; supportsTools: boolean; supportsImages: boolean; models: { id: string; name: string; contextWindow: number; maxOutputTokens: number }[] }[]; exporters?: { id: string; name: string; command: string; extension: string; contentType: string; streaming?: boolean }[]; skills?: { id: string; name: string; description: string; entry: string; resources?: string[] }[]; pages?: PluginPage[]; navigation?: PluginNavigation[]; connectionActions?: PluginConnectionAction[]; sidebar?: PluginSidebarGroup[]; views?: PluginView[] };
  backend?: { default?: { executable: string; args?: string[]; runtime?: string }; platforms?: Record<string, { executable: string; args?: string[]; runtime?: string }> };
  window?: { entry: string; title?: string; width?: number; height?: number };
}
export interface PluginConnectionAction {
  id: string;
  title: string;
  description?: string;
  connectionTypes: string[];
  scopes?: string[];
  target: { type: 'window' | 'page'; page?: string };
}

/** One expandable group the plugin contributes to the left connection tree. */
export interface PluginSidebarGroup {
  id: string;
  title: string;
  icon?: string;
  listCommand: string;
  emptyText?: string;
  open?: { type: 'page' | 'window' | 'panel'; page?: string; view?: string };
  order?: number;
}

/** One page docked to a host surface; version one supports the right dock. */
export interface PluginView {
  id: string;
  title: string;
  page: string;
  location: 'right' | 'bottom';
  icon?: string;
  order?: number;
}

export interface PluginStatus {
  manifest: PluginManifest;
  digest: string;
  state: PluginState;
  desiredEnabled: boolean;
  generation: number;
  lastError?: string;
  installedAt: string;
  /**
   * 清单已无法按当前契约解码：宿主升级后新增的校验会拒绝早期已安装的插件（例如
   * 声明 window 却没带 ui.html-panel）。此时 manifest 只保留身份字段，其余声明
   * 一律不可信也不渲染；该条目的用途只剩「展示原因 + 允许卸载」。
   */
  manifestDegraded?: boolean;
}
export interface PluginInspection {
  manifest: PluginManifest;
  digest: string;
  sourcePath: string;
  sizeBytes: number;
}
export interface PluginRuntimeInfo { safeMode: boolean; managementAllowed: boolean; webRuntime?: boolean }
export interface PluginRemoteSource { kind: 'github' | 'npm'; spec: string; url: string; name: string; version: string }
export interface PluginRemoteInspection {
  inspection: PluginInspection;
  source: PluginRemoteSource;
  artifactDigest: string;
  approvalToken: string;
  expiresAt: string;
}
