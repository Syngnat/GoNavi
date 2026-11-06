import { useEffect } from 'react';
import { useStore } from '../../store';
import { GetSavedConnections } from '../../../wailsjs/go/app/App';
import { EventsOn } from '../../../wailsjs/runtime';
import type { SavedConnection } from '../../types';

// 多客户端共享同一份 connections.json：其他客户端新增/删除/改分组后，
// 后端广播 connections:changed，这里重新拉取列表并替换本地快照。
export const useSavedConnectionsChangeSync = (): void => {
  const replaceConnections = useStore((state) => state.replaceConnections);

  useEffect(() => {
    let disposed = false;
    let running = false;
    let pending = false;

    const refresh = async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        const latest = await GetSavedConnections();
        if (!disposed && Array.isArray(latest)) {
          replaceConnections(latest as SavedConnection[]);
        }
      } catch {
        // 刷新失败保留现有列表，等下一次事件或手动刷新。
      } finally {
        running = false;
        if (pending) {
          pending = false;
          void refresh();
        }
      }
    };

    const off = EventsOn('connections:changed', () => {
      void refresh();
    });
    return () => {
      disposed = true;
      if (typeof off === 'function') {
        off();
      }
    };
  }, [replaceConnections]);
};
