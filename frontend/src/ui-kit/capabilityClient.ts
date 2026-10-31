export type GonaviCapabilityEnvelope = {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
};

export interface GonaviCapabilityBridge {
  capability?: (method: string, args?: unknown) => Promise<unknown>;
  call?: (method: string, args?: unknown) => Promise<unknown>;
}

export class GonaviCapabilityError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message || code);
    this.name = 'GonaviCapabilityError';
  }
}

export interface GonaviClient {
  call<Result = unknown>(method: string, args?: unknown): Promise<Result>;
  has(method: string): boolean;
}

function readBridge(): GonaviCapabilityBridge | null {
  const scope = globalThis as unknown as {
    gonaviPlugin?: GonaviCapabilityBridge;
    gonavi?: GonaviCapabilityBridge;
  };
  if (scope.gonaviPlugin?.capability) return scope.gonaviPlugin;
  if (scope.gonavi?.call) return scope.gonavi;
  return null;
}

/**
 * Creates a capability client for a plugin window or page. The window bridge
 * returns `{ok,data,error}` envelopes; the page bridge resolves to the data
 * directly. Both shapes are normalised here so the rest of the UI does not
 * branch on the host surface.
 */
export function createGonaviClient(bridge: GonaviCapabilityBridge | null = readBridge()): GonaviClient {
  if (!bridge) {
    throw new GonaviCapabilityError('bridge_unavailable', 'No GoNavi plugin bridge is available');
  }
  const invoke = bridge.capability
    ? (method: string, args?: unknown) => bridge.capability!(method, args)
    : (method: string, args?: unknown) => bridge.call!(method, args);

  return {
    has(method: string) {
      return typeof method === 'string' && method.length > 0;
    },
    async call<Result = unknown>(method: string, args: unknown = {}): Promise<Result> {
      const raw = await invoke(method, args);
      if (raw && typeof raw === 'object' && 'ok' in raw) {
        const envelope = raw as GonaviCapabilityEnvelope;
        if (!envelope.ok) {
          throw new GonaviCapabilityError(
            envelope.error?.code || 'capability_failed',
            envelope.error?.message,
          );
        }
        return envelope.data as Result;
      }
      return raw as Result;
    },
  };
}
