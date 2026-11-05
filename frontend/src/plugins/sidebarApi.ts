import { PluginOpenSidebarWindow, PluginSidebarNodeAction, PluginSidebarNodes } from '../../wailsjs/go/app/App';
import { PluginAPIError } from './apiResult';
import { isRecord } from './jsonBoundary';

const MAX_RESULT_BYTES = 256 * 1024;

/** One node context-menu action; the host invokes the declared command. */
export interface PluginSidebarAction {
  id: string;
  title: string;
  command: string;
  arguments?: unknown;
}

/** One host-rendered node returned by a sidebar group's listCommand. */
export interface PluginSidebarNode {
  id: string;
  label: string;
  description?: string;
  badge?: string;
  children?: PluginSidebarNode[];
  open?: { type: 'page' | 'window' | 'panel'; page?: string; view?: string; arguments?: unknown };
  actions?: PluginSidebarAction[];
}

function decodeNodes(data: unknown): PluginSidebarNode[] {
  const encoded = JSON.stringify(data ?? null);
  if (new TextEncoder().encode(encoded).length > MAX_RESULT_BYTES) {
    throw new PluginAPIError('plugin.backend.error.page_result_too_large');
  }
  const record = isRecord(data) ? data : {};
  return Array.isArray(record.items) ? (record.items as PluginSidebarNode[]) : [];
}

function failureMessage(result: unknown): string {
  return isRecord(result) && typeof result.message === 'string' ? result.message.slice(0, 2048) : '';
}

/** Reads one declared group's bounded node tree. The host validates it again. */
export async function loadPluginSidebarNodes(pluginID: string, groupID: string): Promise<PluginSidebarNode[]> {
  let result: unknown;
  try {
    result = await PluginSidebarNodes(pluginID, groupID);
  } catch {
    throw new PluginAPIError('plugin.backend.error.operation_failed');
  }
  if (!isRecord(result) || result.success !== true) {
    throw new PluginAPIError('plugin.backend.error.operation_failed', failureMessage(result));
  }
  return decodeNodes(result.data);
}

/** Opens the plugin's own window for one node; the host owns the launch context. */
/** Runs one node action. The host re-checks that the command is public. */
export async function runPluginSidebarNodeAction(
  pluginID: string,
  groupID: string,
  nodeID: string,
  actionID: string,
  command: string,
  args: unknown,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await PluginSidebarNodeAction(pluginID, groupID, nodeID, actionID, command, JSON.stringify(args ?? {}));
  } catch {
    throw new PluginAPIError('plugin.backend.error.operation_failed');
  }
  if (!isRecord(result) || result.success !== true) {
    throw new PluginAPIError('plugin.backend.error.operation_failed', failureMessage(result));
  }
  return result.data;
}

export async function openPluginSidebarWindow(
  pluginID: string,
  groupID: string,
  nodeID: string,
  args: unknown,
): Promise<void> {
  let result: unknown;
  try {
    result = await PluginOpenSidebarWindow(pluginID, groupID, nodeID, JSON.stringify(args ?? {}));
  } catch {
    throw new PluginAPIError('plugin.backend.error.operation_failed');
  }
  if (!isRecord(result) || result.success !== true) {
    throw new PluginAPIError('plugin.backend.error.operation_failed', failureMessage(result));
  }
}
