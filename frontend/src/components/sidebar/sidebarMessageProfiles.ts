import { t } from '../../i18n';
import type { SavedConnection } from '../../types';
import { resolveDataSourceType } from '../../utils/dataSourceCapabilities';
import type { SidebarMessageQueueType } from './sidebarMessageActions';

export type SidebarMessageObjectKind = 'topic-filter' | 'topic' | 'queue' | 'exchange';
export type SidebarMessageQueueProfile = {
  type: SidebarMessageQueueType;
  namespaceKind: 'topic-filter' | 'topic' | 'vhost';
  namespaceTitle: (databaseName: string) => string;
  resolveObjectKind: (rawType: string) => SidebarMessageObjectKind | null;
  groups?: Array<{ kind: SidebarMessageObjectKind; groupKey: 'queues' | 'exchanges'; titleKey: string }>;
};

export const resolveSidebarMessageQueueProfile = (
  config: SavedConnection['config'] | undefined,
): SidebarMessageQueueProfile | null => {
  const type = resolveDataSourceType(config);
  if (type === 'rabbitmq') {
    return {
      type,
      namespaceKind: 'vhost',
      namespaceTitle: (name) => name,
      resolveObjectKind: (raw) => {
        const kind = raw.trim().toLowerCase();
        return kind === 'queue' || kind === 'exchange' ? kind : null;
      },
      groups: [
        { kind: 'queue', groupKey: 'queues', titleKey: 'sidebar.message_queue.group.queues' },
        { kind: 'exchange', groupKey: 'exchanges', titleKey: 'sidebar.message_queue.group.exchanges' },
      ],
    };
  }
  if (type !== 'mqtt' && type !== 'kafka' && type !== 'rocketmq' && type !== 'pulsar') return null;
  const kind = type === 'mqtt' ? 'topic-filter' : 'topic';
  return {
    type,
    namespaceKind: kind,
    namespaceTitle: () => t(type === 'mqtt' ? 'sidebar.message_queue.namespace.topic_filters' : 'sidebar.message_queue.namespace.topics'),
    resolveObjectKind: (raw) => raw.trim().toLowerCase() === 'topic' ? kind : null,
  };
};
