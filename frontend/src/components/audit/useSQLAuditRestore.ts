import { useCallback } from 'react';
import { message } from 'antd';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import { buildRestoredQueryTab } from '../../utils/sqlAuditTab';
import {
  getSQLAuditRecoveryState,
  isSQLAuditEventRestorable,
  type SQLAuditEvent,
} from './sqlAuditModel';

/** 把审计事件里的 SQL 文本填回查询编辑器（仅文本，不还原数据），按原连接/数据库上下文开新页签。 */
export function useSQLAuditRestore(): (event: SQLAuditEvent) => void {
  const { t } = useI18n();
  const connections = useStore((state) => state.connections);
  const addTab = useStore((state) => state.addTab);

  return useCallback((event: SQLAuditEvent) => {
    const recoveryState = getSQLAuditRecoveryState(event);
    if (!isSQLAuditEventRestorable(event)) {
      message.warning(t(recoveryState === 'metadata'
        ? 'query_history.insert.metadata_unavailable'
        : 'query_history.insert.event_unavailable'));
      return;
    }
    const originalConnectionId = String(event.connectionId || '').trim();
    const connectionAvailable = connections.some((connection) => connection.id === originalConnectionId);
    addTab(buildRestoredQueryTab({
      sourceId: event.id,
      connectionId: connectionAvailable ? originalConnectionId : '',
      dbName: event.database,
      sql: event.sqlText,
      title: t('query_history.insert.tab_title'),
      preserveUnboundConnection: !connectionAvailable,
    }));
    if (!connectionAvailable) {
      message.warning(t('query_history.insert.connection_missing', {
        connectionId: originalConnectionId || t('common.unknown'),
      }));
      return;
    }
    if (recoveryState === 'redacted') {
      message.warning(t('query_history.insert.redacted_warning'));
      return;
    }
    message.success(t('query_history.insert.success'));
  }, [addTab, connections, t]);
}
