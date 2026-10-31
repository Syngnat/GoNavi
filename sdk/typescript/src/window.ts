import type { JSONValue } from './types.js';

export interface PluginWindowIdentity {
  pluginId: string;
  generation: number;
  title: string;
  /** Launch context supplied by the host, if the window was opened from a contribution. */
  context?: JSONValue;
}

export interface PluginInvokeOptions {
  signal?: AbortSignal;
}

export interface PluginPickOptions {
  title?: string;
}

/** Injected only into a separate plugin WebView, never the main application. */
export interface PluginWindowBridge {
  readonly ready: Promise<Readonly<PluginWindowIdentity>>;
  invoke(command: string, args?: JSONValue, options?: PluginInvokeOptions): Promise<JSONValue>;
  capability(method: string, args?: JSONValue, options?: PluginInvokeOptions): Promise<JSONValue>;
  /** Native file picker; resolves to an absolute path on this machine, or null when cancelled. */
  pickFile(options?: PluginPickOptions): Promise<string | null>;
  /** Native directory picker; resolves to an absolute path, or null when cancelled. */
  pickFolder(options?: PluginPickOptions): Promise<string | null>;
  close(): Promise<void>;
}
