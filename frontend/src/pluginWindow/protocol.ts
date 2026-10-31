// This bundle is exclusively loaded in an isolated native child. It must never
// import the main App, store, generated Wails bindings, or a plugin package.
export const bridgePrefix = '/__gonavi/plugin-window/';
export const maxJSONBytes = 1 << 20;

export interface PluginWindowIdentity {
  pluginId: string;
  generation: number;
  title: string;
  context?: unknown;
}

export interface PluginInvokeOptions {
  signal?: AbortSignal;
}

export interface PluginPickOptions {
  title?: string;
}

export interface PluginWindowBridge {
  readonly ready: Promise<Readonly<PluginWindowIdentity>>;
  invoke(command: string, args?: unknown, options?: PluginInvokeOptions): Promise<unknown>;
  capability(method: string, args?: unknown, options?: PluginInvokeOptions): Promise<unknown>;
  // 原生文件选择（返回本机绝对路径或 null=取消）。
  pickFile(options?: PluginPickOptions): Promise<string | null>;
  // 原生目录选择。
  pickFolder(options?: PluginPickOptions): Promise<string | null>;
  close(): Promise<void>;
}

export class PluginBridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PluginBridgeError';
  }
}

export function newPluginRequestID(): string {
  // getRandomValues also works on native custom-scheme origins where browsers
  // may withhold crypto.randomUUID as a secure-context-only API.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function boundedJSON(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || new TextEncoder().encode(json).byteLength > maxJSONBytes) {
    throw new PluginBridgeError('payload_too_large');
  }
  return json;
}

export function parseIdentity(value: unknown): Readonly<PluginWindowIdentity> {
  if (typeof value !== 'object' || value === null) throw new PluginBridgeError('invalid_identity');
  const identity = value as Record<string, unknown>;
  if (typeof identity.pluginId !== 'string' || identity.pluginId.length > 256 ||
      typeof identity.generation !== 'number' || !Number.isSafeInteger(identity.generation) ||
      identity.generation <= 0 || typeof identity.title !== 'string' || identity.title.length > 1024) {
    throw new PluginBridgeError('invalid_identity');
  }
  const context = identity.context === undefined ? undefined : Object.freeze(identity.context);
  return Object.freeze({
    pluginId: identity.pluginId,
    generation: identity.generation,
    title: identity.title,
    ...(context === undefined ? {} : { context }),
  });
}

export async function readBridgeResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    // Do not render server diagnostics/paths as HTML or leak them to plugins.
    throw new PluginBridgeError(response.status === 410 ? 'window_revoked' : 'bridge_request_failed');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PluginBridgeError('invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxJSONBytes) {
        await reader.cancel();
        throw new PluginBridgeError('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
