/** JSON values are data; the host never evaluates their strings. */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type RequestID = string | number;
export interface Entry { executable: string; args?: string[]; runtime?: 'native' | 'node' | 'python' }
export interface Command { id: string; title: string; description?: string; inputSchema?: JSONValue; effect?: 'read' | 'write' | 'unknown' }
export interface UINode {
  type: 'text' | 'alert' | 'column' | 'row' | 'button' | 'table';
  text?: string; title?: string; children?: UINode[]; command?: string; arguments?: JSONValue;
  columns?: { key: string; title: string }[]; rows?: Record<string, JSONValue>[];
}
/** Supported SQL families for the read-only data-source protocol. */
export type DataSourceDialect = 'mysql' | 'postgres' | 'sqlite';
/** Requires data.sources permission and a matching declared backend command. */
export interface DataSource {
  /** Lowercase ASCII: /^[a-z][a-z0-9_.-]{0,63}$/; no namespace separators. */
  id: string; name: string; dialect: DataSourceDialect; command: string;
  /** Omit (or use zero) when the connection has no default port. */
  defaultPort?: number; readOnly: boolean;
}
/** Opaque packaged text: explicit use only, no tools/hooks or automatic prompt injection. */
export interface Skill { id: string; name: string; description: string; entry: string; resources?: string[] }
/** Explicitly loaded opaque text with immutable package/lifecycle provenance. */
export interface SkillContent {
  pluginId: string; skillId: string; name: string; description: string; version: string;
  digest: string; generation: number; content: string;
}
/** Static text/tool model declaration; identifiers are case-sensitive. */
export interface AIModel { id: string; name: string; contextWindow: number; maxOutputTokens: number }
/** Requires ai.providers and an exact backend command; images are not supported in v1. */
export interface AIProvider {
  id: string; name: string; command: string; icon?: string; models: AIModel[];
  supportsTools: boolean; supportsImages: boolean;
}
/** Requires data.export and a backend command; metadata grants no filesystem access. */
export interface Exporter { id: string; name: string; command: string; extension: string; contentType: string; streaming?: boolean }
/** Bounded custom markup for a page; the host renders it only in an opaque-origin sandboxed frame. */
export interface PageHTML { source: string }
/** Requires ui.pages and exactly one of body or html; html also requires ui.html-panel. */
export interface Page { id: string; title: string; body?: UINode; html?: PageHTML }
/** `page` opens a declared page in a tab; `window` opens the manifest window and needs no page. */
export interface Navigation { id: string; title: string; target?: 'page' | 'window'; page?: string; location: 'tools'; order?: number }
export interface LaunchTarget { type: 'window' | 'page'; page?: string }
/** Declared connection/database/collection menu entry; the host owns the launch context. */
export interface ConnectionAction { id: string; title: string; description?: string; connectionTypes: string[]; scopes?: ('connection' | 'database' | 'collection')[]; target: LaunchTarget }
export interface Manifest {
  schemaVersion: 1; apiVersion: 1; id: string; name: string; version: string;
  description?: string; author?: string; license?: string;
  /** Optional installed-plugin logo: a package-relative raster path; falls back to the first AI provider icon. */
  icon?: string;
  minHostVersion?: string;
  permissions: string[];
  permissionNotes?: Record<string, string>;
  requires?: { id: string; minVersion?: string; optional?: boolean }[];
  backend?: { default?: Entry; platforms?: Record<string, Entry> };
  contributes?: { commands?: Command[]; panels?: { id: string; title: string; body?: UINode; html?: PageHTML }[]; dataSources?: DataSource[]; skills?: Skill[]; aiProviders?: AIProvider[]; exporters?: Exporter[]; pages?: Page[]; navigation?: Navigation[]; connectionActions?: ConnectionAction[] };
  window?: { entry: string; title?: string; width?: number; height?: number };
  configSchema?: JSONValue;
}
export interface InitializeParams {
  apiVersion: 1; pluginId: string; version: string; generation: number;
  config: Record<string, JSONValue>; hostVersion: string; locale: string; permissions: string[];
}
export interface InvokeParams { commandId: string; arguments: JSONValue }
export interface RPCRequest { jsonrpc: '2.0'; id?: RequestID; method: string; params?: JSONValue }
export interface RPCError { code: number; message: string; data?: JSONValue }
export type RPCResponse = { jsonrpc: '2.0'; id: RequestID | null } & (
  { result: JSONValue; error?: never } | { result?: never; error: RPCError }
);
export interface Status {
  manifest: Manifest; digest: string; state: 'disabled' | 'starting' | 'running' | 'stopping' | 'faulted' | 'blocked';
  desiredEnabled: boolean; generation: number; lastError?: string; installedAt: string;
}
export interface Inspection { manifest: Manifest; digest: string; sourcePath: string; sizeBytes: number }
