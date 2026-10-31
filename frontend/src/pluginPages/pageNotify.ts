import { message } from 'antd';

const NOTIFY_TYPES = ['success', 'info', 'warning', 'error'] as const;
const MAX_NOTIFY_LENGTH = 1024;

/** ui.notify is handled by the host: the page never decides its own global toast. */
export function showPluginPageNotification(text: string, type?: string): void {
  const kind = NOTIFY_TYPES.find((candidate) => candidate === type) ?? 'info';
  message.open({ type: kind, content: text.slice(0, MAX_NOTIFY_LENGTH) });
}
