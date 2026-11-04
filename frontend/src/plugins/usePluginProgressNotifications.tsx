import React, { useEffect } from 'react';
import { Progress, notification } from 'antd';
import { EventsOn } from '../../wailsjs/runtime/runtime';

export const PLUGIN_PROGRESS_EVENT = 'plugin:progress';

export interface PluginProgressEvent {
  pluginId: string;
  id: string;
  action: 'open' | 'update' | 'close';
  title?: string;
  detail?: string;
  percent?: number;
}

/** Validates one host event; malformed payloads are ignored, never rendered. */
export function decodePluginProgressEvent(value: unknown): PluginProgressEvent | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pluginId !== 'string' || !record.pluginId) return null;
  if (typeof record.id !== 'string' || !record.id) return null;
  const action = record.action;
  if (action !== 'open' && action !== 'update' && action !== 'close') return null;
  const percent = typeof record.percent === 'number' && Number.isFinite(record.percent)
    ? Math.min(100, Math.max(0, record.percent))
    : undefined;
  return {
    pluginId: record.pluginId,
    id: record.id,
    action,
    ...(typeof record.title === 'string' && record.title ? { title: record.title.slice(0, 128) } : {}),
    ...(typeof record.detail === 'string' && record.detail ? { detail: record.detail.slice(0, 256) } : {}),
    ...(percent === undefined ? {} : { percent }),
  };
}

export const pluginProgressKey = (event: PluginProgressEvent): string =>
  `plugin-progress:${event.pluginId}:${event.id}`;

/**
 * Renders `progress.report` events as host notifications. The plugin owns the
 * task; the host only displays the bounded title, detail and percentage.
 */
export function usePluginProgressNotifications(): void {
  useEffect(() => {
    const off = EventsOn(PLUGIN_PROGRESS_EVENT, (payload: unknown) => {
      const event = decodePluginProgressEvent(payload);
      if (!event) return;
      const key = pluginProgressKey(event);
      if (event.action === 'close') {
        notification.destroy(key);
        return;
      }
      notification.open({
        key,
        message: event.title || '任务进度',
        description: (
          <div>
            <Progress percent={event.percent ?? 0} size="small" status={event.percent === 100 ? 'success' : 'active'} />
            {event.detail ? <div style={{ fontSize: 12, opacity: 0.7 }}>{event.detail}</div> : null}
          </div>
        ),
        duration: 0,
        placement: 'bottomRight',
      });
    });
    return () => { off?.(); };
  }, []);
}
