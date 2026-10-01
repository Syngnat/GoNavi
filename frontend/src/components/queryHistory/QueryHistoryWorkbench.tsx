import { useCallback, useMemo, useState } from 'react';
import { Button, Tooltip, Typography, message } from 'antd';
import { HistoryOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import { useWorkbenchThemeStyle } from '../common/useWorkbenchThemeStyle';
import type { TabData } from '../../types';
import SqlAuditDetailDrawer from '../audit/SqlAuditDetailDrawer';
import SqlAuditSettingsDrawer from '../audit/SqlAuditSettingsDrawer';
import { resolveSQLAuditBackend, type SQLAuditBackend } from '../audit/sqlAuditRpc';
import { useSQLAuditRestore } from '../audit/useSQLAuditRestore';
import type { SQLAuditEvent } from '../audit/sqlAuditModel';
import { createQueryHistoryFormatters } from './queryHistoryFormat';
import QueryHistoryList from './QueryHistoryList';
import QueryHistoryNotices from './QueryHistoryNotices';
import QueryHistoryPreview from './QueryHistoryPreview';
import QueryHistoryToolbar from './QueryHistoryToolbar';
import { useQueryHistoryEvents } from './useQueryHistoryEvents';
import './QueryHistoryWorkbench.css';

const { Text, Title } = Typography;

interface QueryHistoryWorkbenchProps {
  tab: TabData;
  backend?: SQLAuditBackend;
  isActive?: boolean;
}

export default function QueryHistoryWorkbench({ tab, backend: backendOverride, isActive = true }: QueryHistoryWorkbenchProps) {
  const { t, language } = useI18n();
  const connections = useStore((state) => state.connections);
  const backend = backendOverride ?? resolveSQLAuditBackend();
  const restoreEvent = useSQLAuditRestore();
  const history = useQueryHistoryEvents(tab, backend);
  const [selectedId, setSelectedId] = useState('');
  const [detailEvent, setDetailEvent] = useState<SQLAuditEvent | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const formatters = useMemo(() => createQueryHistoryFormatters(language), [language]);
  const connectionNameById = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection.name])),
    [connections],
  );
  const selectedEvent = history.page.items.find((item) => item.id === selectedId) ?? history.page.items[0] ?? null;

  const copySql = useCallback(async (event: SQLAuditEvent) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(event.sqlText);
      message.success(t('sql_audit.message.sql_copied'));
    } catch {
      message.error(t('sql_audit.message.copy_failed'));
    }
  }, [t]);

  const workbenchStyle = useWorkbenchThemeStyle();

  return (
    <main className="gn-qh gn-wb-theme" style={workbenchStyle} aria-labelledby="query-history-title">
      <header className="gn-qh-header">
        <div className="gn-qh-title-group">
          <span className="gn-qh-title-icon" aria-hidden="true"><HistoryOutlined /></span>
          <div className="gn-qh-title-copy">
            <Title level={5} id="query-history-title">{t('query_history.workbench.title')}</Title>
            <Text type="secondary">{t('query_history.workbench.description')}</Text>
          </div>
        </div>
        <div className="gn-qh-header-actions">
          <Tooltip title={t('common.refresh')}>
            <Button
              icon={<ReloadOutlined aria-hidden="true" />}
              loading={history.loading}
              aria-label={t('common.refresh')}
              onClick={history.reload}
            />
          </Tooltip>
          <Button icon={<SettingOutlined aria-hidden="true" />} onClick={() => setSettingsOpen(true)}>
            {t('sql_audit.action.settings')}
          </Button>
        </div>
      </header>

      <QueryHistoryNotices backend={backend} refreshKey={history.reloadKey} isActive={isActive} />

      <QueryHistoryToolbar
        filter={history.filter}
        counts={history.counts}
        connections={connections}
        hasActiveFilters={history.hasActiveFilters}
        onFieldChange={history.setFilterField}
        onReset={history.resetFilters}
      />

      {history.error ? (
        <div className="gn-qh-error" role="alert">
          <Text type="danger">{t('query_history.error.load_failed')}: {history.error}</Text>
          <Button size="small" onClick={history.reload}>{t('common.retry')}</Button>
        </div>
      ) : null}

      <div className="gn-qh-body">
        <QueryHistoryList
          items={history.page.items}
          total={history.page.total}
          page={history.filter.page}
          pageSize={history.filter.pageSize}
          loading={history.loading}
          hasActiveFilters={history.hasActiveFilters}
          selectedId={selectedEvent?.id ?? ''}
          connectionNameById={connectionNameById}
          formatters={formatters}
          onSelect={setSelectedId}
          onRestore={restoreEvent}
          onCopySql={copySql}
          onPaginationChange={history.setPagination}
          onResetFilters={history.resetFilters}
        />
        <QueryHistoryPreview
          event={selectedEvent}
          connectionName={selectedEvent ? connectionNameById.get(selectedEvent.connectionId) || '' : ''}
          formatters={formatters}
          onRestore={restoreEvent}
          onCopySql={copySql}
          onOpenAuditDetail={setDetailEvent}
        />
      </div>

      <SqlAuditDetailDrawer
        event={detailEvent}
        open={!!detailEvent}
        onClose={() => setDetailEvent(null)}
        backend={backend}
        connectionName={detailEvent ? connectionNameById.get(detailEvent.connectionId) : undefined}
        onRestore={restoreEvent}
      />
      <SqlAuditSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={history.reload}
        backend={backend}
      />
    </main>
  );
}
