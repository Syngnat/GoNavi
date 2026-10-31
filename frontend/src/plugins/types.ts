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
  page: string;
  location: 'tools';
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
  contributes?: { commands?: PluginCommand[]; panels?: PluginPanel[]; dataSources?: { id: string; name: string; dialect: string; command: string; defaultPort?: number; readOnly: boolean }[]; aiProviders?: { id: string; name: string; command: string; icon?: string; supportsTools: boolean; supportsImages: boolean; models: { id: string; name: string; contextWindow: number; maxOutputTokens: number }[] }[]; exporters?: { id: string; name: string; command: string; extension: string; contentType: string; streaming?: boolean }[]; skills?: { id: string; name: string; description: string; entry: string; resources?: string[] }[]; pages?: PluginPage[]; navigation?: PluginNavigation[]; connectionActions?: PluginConnectionAction[] };
  backend?: { default?: { executable: string; args?: string[]; runtime?: string }; platforms?: Record<string, { executable: string; args?: string[]; runtime?: string }> };
  window?: { entry: string; title?: string; width?: number; height?: number };
  configSchema?: unknown;
}
export interface PluginConnectionAction {
  id: string;
  title: string;
  description?: string;
  connectionTypes: string[];
  scopes?: string[];
  target: { type: 'window' | 'page'; page?: string };
}

export interface PluginStatus {
  manifest: PluginManifest;
  digest: string;
  state: PluginState;
  desiredEnabled: boolean;
  generation: number;
  lastError?: string;
  installedAt: string;
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
