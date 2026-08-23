import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Pagination,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import Modal from '../common/ResizableDraggableModal';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  ClearOutlined,
  ExportOutlined,
  EyeOutlined,
  HistoryOutlined,
  ImportOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import type { TabData } from '../../types';
import { downloadBrowserTextFile } from '../../utils/browserFileTransfer';
import {
  buildSQLAuditFilterPayload,
  DEFAULT_SQL_AUDIT_FILTER,
  getSQLAuditEnumLabelKey,
  getSQLAuditEventPreview,
  getSQLAuditPrimaryRowCount,
  getSQLAuditRecoveryState,
  isSQLAuditEventRestorable,
  normalizeSQLAuditPage,
  SQL_AUDIT_EVENT_TYPES,
  SQL_AUDIT_SOURCES,
  SQL_AUDIT_STATUSES,
  type SQLAuditEvent,
  type SQLAuditFilter,
  type SQLAuditPage,
} from './sqlAuditModel';
import SqlAuditDetailDrawer from './SqlAuditDetailDrawer';
import SqlAuditHealthAlert from './SqlAuditHealthAlert';
import SqlAuditSettingsDrawer from './SqlAuditSettingsDrawer';
import {
  requireSQLAuditMethod,
  resolveSQLAuditBackend,
  unwrapSQLAuditResult,
  type SQLAuditBackend,
} from './sqlAuditRpc';
import { buildRestoredQueryTab } from '../../utils/sqlAuditTab';
import './SqlAuditWorkbench.css';

const { Text, Title } = Typography;
const SQL_AUDIT_SEARCH_DEBOUNCE_MS = 250;

const EMPTY_AUDIT_PAGE: SQLAuditPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_SQL_AUDIT_FILTER.pageSize,
  summary: {
    totalEvents: 0,
    successCount: 0,
    errorCount: 0,
    transactionCount: 0,
    cancelledCount: 0,
  },
};

type IntegrityState = {
  type: 'success' | 'error';
  message: string;
  description?: string;
} | null;

interface SqlAuditWorkbenchProps {
  tab: TabData;
  backend?: SQLAuditBackend;
  isActive?: boolean;
}

const resolveStatusColor = (status: string): string => {
  if (status === 'success') return 'success';
  if (status === 'error') return 'error';
  if (status === 'cancelled') return 'warning';
  return 'default';
};

const uniqueOptions = (
  knownValues: readonly string[],
  discoveredValues: string[],
  resolveLabel: (value: string) => string,
) => Array.from(new Set([...knownValues, ...discoveredValues].map((value) => String(value || '').trim()).filter(Boolean)))
  .map((value) => ({ value, label: resolveLabel(value) }));

const formatDateTimeInputValue = (timestamp?: number): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
};

const parseDateTimeInputValue = (value: string): number | undefined => {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

export default function SqlAuditWorkbench({ tab, backend: backendOverride, isActive = true }: SqlAuditWorkbenchProps) {
  const { t, language } = useI18n();
  const { token } = theme.useToken();
  const connections = useStore((state) => state.connections);
  const addTab = useStore((state) => state.addTab);
  const queryHistoryMode = tab.sqlAuditView === 'query-history';
  const [filter, setFilter] = useState<SQLAuditFilter>(() => ({
    ...DEFAULT_SQL_AUDIT_FILTER,
    connectionId: String(tab.connectionId || '').trim(),
    database: queryHistoryMode ? String(tab.dbName || '').trim() : '',
    transactionId: String(tab.sqlAuditTransactionId || '').trim(),
  }));
  const [debouncedSearch, setDebouncedSearch] = useState(filter.search);
  const [pageData, setPageData] = useState<SQLAuditPage>(EMPTY_AUDIT_PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<SQLAuditEvent | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [integrityState, setIntegrityState] = useState<IntegrityState>(null);
  const requestSequenceRef = useRef(0);
  const backend = backendOverride ?? resolveSQLAuditBackend();

  useEffect(() => {
    setFilter((current) => ({
      ...current,
      connectionId: String(tab.connectionId || '').trim(),
      database: queryHistoryMode ? String(tab.dbName || '').trim() : '',
      transactionId: String(tab.sqlAuditTransactionId || '').trim(),
      page: 1,
    }));
  }, [queryHistoryMode, tab.connectionId, tab.dbName, tab.sqlAuditRequestKey, tab.sqlAuditTransactionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(filter.search);
    }, SQL_AUDIT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filter.search]);

  const numberFormatter = useMemo(() => new Intl.NumberFormat(language), [language]);
  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(language, {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false,
  }), [language]);
  const connectionNameById = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection.name])),
    [connections],
  );
  const requestFilter = useMemo<SQLAuditFilter>(() => ({
    search: debouncedSearch,
    connectionId: filter.connectionId,
    database: filter.database,
    dbType: filter.dbType,
    eventType: filter.eventType,
    status: filter.status,
    transactionId: filter.transactionId,
    source: filter.source,
    fromTimestamp: filter.fromTimestamp,
    toTimestamp: filter.toTimestamp,
    page: filter.page,
    pageSize: filter.pageSize,
  }), [
    debouncedSearch,
    filter.connectionId,
    filter.database,
    filter.dbType,
    filter.eventType,
    filter.fromTimestamp,
    filter.page,
    filter.pageSize,
    filter.source,
    filter.status,
    filter.toTimestamp,
    filter.transactionId,
  ]);
  const filterPayload = useMemo(
    () => buildSQLAuditFilterPayload(requestFilter, { executionHistory: queryHistoryMode }),
    [queryHistoryMode, requestFilter],
  );

  const labelEnum = useCallback((kind: 'event_type' | 'status' | 'source', value: string): string => {
    const key = getSQLAuditEnumLabelKey(kind, value);
    return key ? t(key) : (value || t('common.unknown'));
  }, [t]);

  const loadEvents = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    setError('');
    try {
      const getEvents = requireSQLAuditMethod(backend, 'GetSQLAuditEvents');
      const result = await getEvents(filterPayload);
      if (requestSequence !== requestSequenceRef.current) return;
      setPageData(normalizeSQLAuditPage(unwrapSQLAuditResult(result), requestFilter));
    } catch (cause) {
      if (requestSequence !== requestSequenceRef.current) return;
      setPageData((current) => ({ ...EMPTY_AUDIT_PAGE, page: requestFilter.page, pageSize: requestFilter.pageSize, summary: current.summary }));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [backend, filterPayload, requestFilter]);

  useEffect(() => {
    void loadEvents();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [loadEvents, reloadKey]);

  const updateFilter = <K extends keyof SQLAuditFilter>(key: K, value: SQLAuditFilter[K]) => {
    setFilter((current) => ({ ...current, [key]: value, page: key === 'page' ? Number(value) : 1 }));
  };

  const resetFilters = () => {
    setFilter({ ...DEFAULT_SQL_AUDIT_FILTER });
    setIntegrityState(null);
  };

  const hasActiveFilters = Boolean(
    filter.search
    || filter.connectionId
    || filter.database
    || filter.dbType
    || filter.eventType
    || filter.status
    || filter.transactionId
    || filter.source
    || filter.fromTimestamp
    || filter.toTimestamp,
  );

  const handleVerifyIntegrity = async () => {
    setVerifying(true);
    setIntegrityState(null);
    try {
      const verifyIntegrity = requireSQLAuditMethod(backend, 'VerifySQLAuditIntegrity');
      const data = (unwrapSQLAuditResult(await verifyIntegrity()) || {}) as Record<string, unknown>;
      const valid = data.valid !== false;
      const partialChain = data.partialChain === true || data.truncatedPrefix === true;
      const checkedRecords = Number(data.checkedRecords ?? data.checkedCount ?? 0);
      const verificationDetails = [
        checkedRecords > 0
          ? t('sql_audit.integrity.checked_records', { count: numberFormatter.format(checkedRecords) })
          : '',
        partialChain ? t('sql_audit.integrity.partial_chain') : '',
        data.weakValidation === true ? t('sql_audit.integrity.weak_validation') : '',
        !valid ? String(data.message || '').trim() : '',
      ].filter(Boolean);
      setIntegrityState({
        type: valid ? 'success' : 'error',
        message: valid
          ? t(partialChain ? 'sql_audit.integrity.valid_partial' : 'sql_audit.integrity.valid')
          : t('sql_audit.integrity.invalid'),
        description: verificationDetails.join(' ') || undefined,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setIntegrityState({ type: 'error', message: t('sql_audit.integrity.verify_failed'), description: detail });
    } finally {
      setVerifying(false);
    }
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (pageData.total <= 0) return;
    setExporting(true);
    try {
      const isWebRuntime = typeof window !== 'undefined'
        && (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web';
      if (!isWebRuntime && typeof backend.ExportSQLAuditFile === 'function') {
        const result = await backend.ExportSQLAuditFile(filterPayload, format);
        const cancellationMessage = String(result?.message || '').trim().toLocaleLowerCase();
        if (result?.success === false && (cancellationMessage === 'cancelled' || cancellationMessage === '已取消')) {
          return;
        }
        const data = (unwrapSQLAuditResult(result) || {}) as Record<string, unknown>;
        const filePath = String(data.filePath || data.path || data.fileName || '').trim();
        message.success(t('sql_audit.export.desktop_success', { filePath }));
        return;
      }
      const buildExport = requireSQLAuditMethod(backend, 'BuildSQLAuditExport');
      const data = (unwrapSQLAuditResult(await buildExport(filterPayload, format)) || {}) as Record<string, unknown>;
      const fileName = String(data.fileName || `gonavi-sql-audit.${format}`).trim();
      const mimeType = String(data.mimeType || (format === 'json' ? 'application/json' : 'text/csv;charset=utf-8')).trim();
      const content = typeof data.content === 'string' ? data.content : '';
      if (!content || !downloadBrowserTextFile(content, fileName, mimeType)) {
        throw new Error(t('sql_audit.export.unavailable'));
      }
      message.success(t('sql_audit.export.success', { fileName }));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      message.error(t('sql_audit.export.failed', { detail }));
    } finally {
      setExporting(false);
    }
  };

  const handleClear = () => {
    Modal.confirm({
      title: t('sql_audit.clear.title'),
      content: t('sql_audit.clear.description'),
      okText: t('sql_audit.clear.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true, loading: clearing },
      onOk: async () => {
        setClearing(true);
        try {
          const clearEvents = requireSQLAuditMethod(backend, 'ClearSQLAuditEvents');
          unwrapSQLAuditResult(await clearEvents(Date.now() + 1));
          setSelectedEvent(null);
          setIntegrityState(null);
          setPageData(EMPTY_AUDIT_PAGE);
          setReloadKey((current) => current + 1);
          message.success(t('sql_audit.clear.success'));
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          message.error(t('sql_audit.clear.failed', { detail }));
          throw cause;
        } finally {
          setClearing(false);
        }
      },
    });
  };

  const formatDateTime = (timestamp: number): string => (
    timestamp > 0 ? dateTimeFormatter.format(new Date(timestamp)) : '-'
  );

  const handleRestoreEvent = useCallback((event: SQLAuditEvent) => {
    const recoveryState = getSQLAuditRecoveryState(event);
    if (!isSQLAuditEventRestorable(event)) {
      message.warning(t(recoveryState === 'metadata'
        ? 'query_history.restore.metadata_unavailable'
        : 'query_history.restore.event_unavailable'));
      return;
    }
    const originalConnectionId = String(event.connectionId || '').trim();
    const connectionAvailable = connections.some((connection) => connection.id === originalConnectionId);
    addTab(buildRestoredQueryTab({
      sourceId: event.id,
      connectionId: connectionAvailable ? originalConnectionId : '',
      dbName: event.database,
      sql: event.sqlText,
      title: t('query_history.restore.tab_title'),
      preserveUnboundConnection: !connectionAvailable,
    }));
    if (!connectionAvailable) {
      message.warning(t('query_history.restore.connection_missing', {
        connectionId: originalConnectionId || t('common.unknown'),
      }));
      return;
    }
    if (recoveryState === 'redacted') {
      message.warning(t('query_history.restore.redacted_warning'));
      return;
    }
    message.success(t('query_history.restore.success'));
  }, [addTab, connections, t]);

  const recoveryLabel = useCallback((event: SQLAuditEvent): string => (
    t(`query_history.recovery.${getSQLAuditRecoveryState(event)}` as any)
  ), [t]);

  const eventTypeOptions = useMemo(() => uniqueOptions(
    SQL_AUDIT_EVENT_TYPES,
    pageData.items.map((item) => item.eventType),
    (value) => labelEnum('event_type', value),
  ), [labelEnum, pageData.items]);
  const statusOptions = useMemo(() => uniqueOptions(
    SQL_AUDIT_STATUSES,
    pageData.items.map((item) => item.status),
    (value) => labelEnum('status', value),
  ), [labelEnum, pageData.items]);
  const sourceOptions = useMemo(() => uniqueOptions(
    SQL_AUDIT_SOURCES,
    pageData.items.map((item) => item.source),
    (value) => labelEnum('source', value),
  ), [labelEnum, pageData.items]);
  const dbTypeOptions = useMemo(() => Array.from(new Set([
    ...connections.map((connection) => String(connection.config?.type || '').trim()),
    ...pageData.items.map((item) => item.dbType),
  ].filter(Boolean))).sort().map((value) => ({ value, label: value })), [connections, pageData.items]);

  const columns = useMemo<ColumnsType<SQLAuditEvent>>(() => {
    const auditColumns: ColumnsType<SQLAuditEvent> = [
    {
      title: t('sql_audit.column.time'),
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 168,
      render: (value: number) => <time dateTime={new Date(value).toISOString()}>{formatDateTime(value)}</time>,
    },
    {
      title: t('sql_audit.column.status'),
      dataIndex: 'status',
      key: 'status',
      width: 92,
      render: (value: string) => <Tag color={resolveStatusColor(value)}>{labelEnum('status', value)}</Tag>,
    },
    {
      title: t('sql_audit.column.connection'),
      dataIndex: 'connectionId',
      key: 'connectionId',
      width: 150,
      ellipsis: true,
      render: (value: string) => <Tooltip title={value}><span>{connectionNameById.get(value) || value || '-'}</span></Tooltip>,
    },
    {
      title: t('sql_audit.column.database'),
      dataIndex: 'database',
      key: 'database',
      width: 130,
      ellipsis: true,
      render: (value: string) => value || '-',
    },
    {
      title: t('sql_audit.column.event_type'),
      dataIndex: 'eventType',
      key: 'eventType',
      width: 150,
      render: (value: string) => labelEnum('event_type', value),
    },
    {
      title: t('sql_audit.column.sql'),
      dataIndex: 'sqlText',
      key: 'sqlText',
      width: 360,
      render: (_value: string, record) => (
        <div className="gn-sql-audit-sql-cell">
          <code title={record.sqlText}>{getSQLAuditEventPreview(record) || t('sql_audit.detail.no_sql')}</code>
          {record.sqlRedacted ? <Tag color="processing">{t('sql_audit.detail.redacted')}</Tag> : null}
        </div>
      ),
    },
    {
      title: t('sql_audit.column.duration'),
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 100,
      align: 'right',
      render: (value: number) => `${numberFormatter.format(value)} ms`,
    },
    {
      title: t('sql_audit.column.rows'),
      key: 'rows',
      width: 100,
      align: 'right',
      render: (_value, record) => numberFormatter.format(getSQLAuditPrimaryRowCount(record)),
    },
    {
      title: t('query_history.column.recovery'),
      key: 'recovery',
      width: 116,
      render: (_value, record) => {
        const recoveryState = getSQLAuditRecoveryState(record);
        return (
          <Tag color={recoveryState === 'complete' ? 'success' : recoveryState === 'redacted' ? 'processing' : 'default'}>
            {recoveryLabel(record)}
          </Tag>
        );
      },
    },
    {
      title: t('sql_audit.column.source'),
      dataIndex: 'source',
      key: 'source',
      width: 120,
      render: (value: string) => labelEnum('source', value),
    },
    {
      title: t('sql_audit.column.action'),
      key: 'action',
      width: 112,
      fixed: 'right',
      render: (_value, record) => {
        const recoveryState = getSQLAuditRecoveryState(record);
        const restorable = isSQLAuditEventRestorable(record);
        const restoreHint = recoveryState === 'metadata'
          ? t('query_history.restore.metadata_unavailable')
          : !restorable
            ? t('query_history.restore.event_unavailable')
          : recoveryState === 'redacted'
            ? t('query_history.restore.redacted_tooltip')
            : t('query_history.restore.action');
        return (
          <Space size={2}>
            <Tooltip title={restoreHint}>
              <span>
                <Button
                  type="text"
                  size="small"
                  icon={<ImportOutlined aria-hidden="true" />}
                  aria-label={t('query_history.restore.action')}
                  disabled={!restorable}
                  onClick={() => handleRestoreEvent(record)}
                />
              </span>
            </Tooltip>
            <Tooltip title={t('sql_audit.action.view_detail')}>
              <Button
                type="text"
                size="small"
                icon={<EyeOutlined aria-hidden="true" />}
                aria-label={t('sql_audit.action.view_detail')}
                onClick={() => setSelectedEvent(record)}
              />
            </Tooltip>
          </Space>
        );
      },
    },
    ];
    if (!queryHistoryMode) return auditColumns;
    return auditColumns.filter((column) => column.key !== 'eventType' && column.key !== 'source');
  }, [connectionNameById, dateTimeFormatter, handleRestoreEvent, labelEnum, numberFormatter, queryHistoryMode, recoveryLabel, t]);

  const hasLoadedRecords = pageData.items.length > 0;
  const emptyDescription = hasActiveFilters
    ? t(queryHistoryMode ? 'query_history.empty.no_matches' : 'sql_audit.empty.no_matches')
    : t(queryHistoryMode ? 'query_history.empty.no_records' : 'sql_audit.empty.no_records');
  const detailConnectionName = selectedEvent ? connectionNameById.get(selectedEvent.connectionId) : undefined;
  const workbenchStyle = {
    '--sql-audit-bg': token.colorBgLayout,
    '--sql-audit-panel': token.colorBgContainer,
    '--sql-audit-subtle': token.colorFillQuaternary,
    '--sql-audit-border': token.colorBorderSecondary,
    '--sql-audit-text': token.colorText,
    '--sql-audit-muted': token.colorTextSecondary,
    '--sql-audit-primary': token.colorPrimary,
  } as React.CSSProperties;

  return (
    <main className="gn-sql-audit-workbench" style={workbenchStyle} aria-labelledby="sql-audit-workbench-title" aria-busy={loading}>
      <header className="gn-sql-audit-header">
        <div className="gn-sql-audit-title-group">
          <div className="gn-sql-audit-title-icon" aria-hidden="true">
            {queryHistoryMode ? <HistoryOutlined /> : <AuditOutlined />}
          </div>
          <div className="gn-sql-audit-title-copy">
            <Title level={4} id="sql-audit-workbench-title">
              {t(queryHistoryMode ? 'query_history.workbench.title' : 'sql_audit.workbench.title')}
            </Title>
            <Text type="secondary">
              {t(queryHistoryMode ? 'query_history.workbench.description' : 'sql_audit.workbench.description')}
            </Text>
          </div>
        </div>
        <Space wrap className="gn-sql-audit-header-actions">
          {!queryHistoryMode ? (
            <>
              <Tooltip title={t('sql_audit.action.verify')}>
                <Button icon={<SafetyCertificateOutlined aria-hidden="true" />} loading={verifying} onClick={() => void handleVerifyIntegrity()}>
                  {t('sql_audit.action.verify')}
                </Button>
              </Tooltip>
              <Dropdown
                menu={{
                  items: [
                    { key: 'json', label: t('sql_audit.action.export_json') },
                    { key: 'csv', label: t('sql_audit.action.export_csv') },
                  ],
                  onClick: ({ key }) => void handleExport(key as 'json' | 'csv'),
                }}
                disabled={pageData.total <= 0 || exporting}
              >
                <Button icon={<ExportOutlined aria-hidden="true" />} loading={exporting}>{t('sql_audit.action.export')}</Button>
              </Dropdown>
            </>
          ) : null}
          <Button icon={<SettingOutlined aria-hidden="true" />} onClick={() => setSettingsOpen(true)}>{t('sql_audit.action.settings')}</Button>
          {!queryHistoryMode ? (
            <Button danger icon={<ClearOutlined aria-hidden="true" />} disabled={pageData.total <= 0} loading={clearing} onClick={handleClear}>{t('sql_audit.action.clear')}</Button>
          ) : null}
        </Space>
      </header>

      <Alert
        className="gn-sql-audit-privacy-note"
        type="info"
        showIcon
        message={t(queryHistoryMode ? 'query_history.privacy.title' : 'sql_audit.privacy.title')}
        description={t(queryHistoryMode ? 'query_history.privacy.description' : 'sql_audit.privacy.description')}
      />
      <SqlAuditHealthAlert backend={backend} refreshKey={reloadKey} isActive={isActive} />

      <section className="gn-sql-audit-toolbar" aria-label={t(queryHistoryMode ? 'query_history.filter.aria_label' : 'sql_audit.filter.aria_label')}>
        <Input
          value={filter.search}
          onChange={(event) => updateFilter('search', event.target.value)}
          prefix={<SearchOutlined aria-hidden="true" />}
          placeholder={t(queryHistoryMode ? 'query_history.filter.search_placeholder' : 'sql_audit.filter.search_placeholder')}
          aria-label={t(queryHistoryMode ? 'query_history.filter.search_aria_label' : 'sql_audit.filter.search_aria_label')}
          name="sql-audit-search"
          autoComplete="off"
          allowClear
          className="gn-sql-audit-filter-search"
        />
        <Select
          value={filter.connectionId || undefined}
          onChange={(value) => updateFilter('connectionId', value || '')}
          placeholder={t('sql_audit.filter.connection')}
          aria-label={t('sql_audit.filter.connection')}
          allowClear
          showSearch
          optionFilterProp="label"
          options={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
        />
        <Input
          value={filter.database}
          onChange={(event) => updateFilter('database', event.target.value)}
          placeholder={t('sql_audit.filter.database')}
          aria-label={t('sql_audit.filter.database')}
          name="sql-audit-database"
          autoComplete="off"
          allowClear
        />
        <Select
          value={filter.dbType || undefined}
          onChange={(value) => updateFilter('dbType', value || '')}
          placeholder={t('sql_audit.filter.db_type')}
          aria-label={t('sql_audit.filter.db_type')}
          allowClear
          showSearch
          optionFilterProp="label"
          options={dbTypeOptions}
        />
        {!queryHistoryMode ? (
          <Select
            value={filter.eventType || undefined}
            onChange={(value) => updateFilter('eventType', value || '')}
            placeholder={t('sql_audit.filter.event_type')}
            aria-label={t('sql_audit.filter.event_type')}
            allowClear
            options={eventTypeOptions}
          />
        ) : null}
        <Select
          value={filter.status || undefined}
          onChange={(value) => updateFilter('status', value || '')}
          placeholder={t('sql_audit.filter.status')}
          aria-label={t('sql_audit.filter.status')}
          allowClear
          options={statusOptions}
        />
        {!queryHistoryMode ? (
          <>
            <Select
              value={filter.source || undefined}
              onChange={(value) => updateFilter('source', value || '')}
              placeholder={t('sql_audit.filter.source')}
              aria-label={t('sql_audit.filter.source')}
              allowClear
              options={sourceOptions}
            />
            <Input
              value={filter.transactionId}
              onChange={(event) => updateFilter('transactionId', event.target.value)}
              placeholder={t('sql_audit.filter.transaction_id')}
              aria-label={t('sql_audit.filter.transaction_id')}
              name="sql-audit-transaction-id"
              autoComplete="off"
              spellCheck={false}
              allowClear
            />
          </>
        ) : null}
        <div className="gn-sql-audit-filter-time" role="group" aria-label={t('sql_audit.filter.time_range')}>
          <Input
            type="datetime-local"
            value={formatDateTimeInputValue(filter.fromTimestamp)}
            onChange={(event) => updateFilter('fromTimestamp', parseDateTimeInputValue(event.target.value))}
            aria-label={t('sql_audit.filter.time_from')}
            name="sql-audit-time-from"
            autoComplete="off"
          />
          <Input
            type="datetime-local"
            value={formatDateTimeInputValue(filter.toTimestamp)}
            onChange={(event) => updateFilter('toTimestamp', parseDateTimeInputValue(event.target.value))}
            aria-label={t('sql_audit.filter.time_to')}
            name="sql-audit-time-to"
            autoComplete="off"
          />
        </div>
        <div className="gn-sql-audit-toolbar-actions">
          <Button icon={<ReloadOutlined aria-hidden="true" />} loading={loading} onClick={() => setReloadKey((current) => current + 1)}>{t('common.refresh')}</Button>
          <Button disabled={!hasActiveFilters} onClick={resetFilters}>{t('sql_audit.action.reset_filters')}</Button>
        </div>
      </section>

      <section className="gn-sql-audit-summary" aria-label={t(queryHistoryMode ? 'query_history.summary.aria_label' : 'sql_audit.summary.aria_label')} aria-live="polite">
        {[
          { key: 'total', label: t(queryHistoryMode ? 'query_history.summary.records' : 'sql_audit.summary.events'), value: pageData.summary.totalEvents || pageData.total },
          { key: 'success', label: t('sql_audit.summary.success'), value: pageData.summary.successCount },
          { key: 'error', label: t('sql_audit.summary.errors'), value: pageData.summary.errorCount },
          { key: 'transactions', label: t('sql_audit.summary.transactions'), value: pageData.summary.transactionCount },
        ].map((item) => (
          <div key={item.key} className={`gn-sql-audit-summary-card is-${item.key}`}>
            <span>{item.label}</span>
            <strong>{numberFormatter.format(item.value)}</strong>
          </div>
        ))}
      </section>

      {integrityState ? (
        <Alert
          className="gn-sql-audit-integrity-alert"
          type={integrityState.type}
          showIcon
          closable
          onClose={() => setIntegrityState(null)}
          message={integrityState.message}
          description={integrityState.description}
        />
      ) : null}
      {error ? (
        <Alert
          className="gn-sql-audit-load-alert"
          type="error"
          showIcon
          message={t(queryHistoryMode ? 'query_history.error.load_failed' : 'sql_audit.error.load_failed')}
          description={error}
          action={<Button size="small" onClick={() => setReloadKey((current) => current + 1)}>{t('common.retry')}</Button>}
        />
      ) : null}

      <section className="gn-sql-audit-table-panel" aria-label={t(queryHistoryMode ? 'query_history.table.aria_label' : 'sql_audit.table.aria_label')}>
        {hasLoadedRecords || loading ? (
          <Table<SQLAuditEvent>
            rowKey="id"
            columns={columns}
            dataSource={pageData.items}
            loading={loading}
            pagination={false}
            size="small"
            tableLayout="fixed"
            scroll={{ x: queryHistoryMode ? 1278 : 1672, y: '100%' }}
            rowClassName="gn-sql-audit-table-row"
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={emptyDescription}
          >
            {hasActiveFilters ? <Button onClick={resetFilters}>{t('sql_audit.action.reset_filters')}</Button> : null}
          </Empty>
        )}
        <div className="gn-sql-audit-pagination">
          <Text type="secondary">{t('sql_audit.pagination.total', { count: numberFormatter.format(pageData.total) })}</Text>
          <Pagination
            current={filter.page}
            pageSize={filter.pageSize}
            total={pageData.total}
            showSizeChanger
            pageSizeOptions={[25, 50]}
            onChange={(page, pageSize) => setFilter((current) => ({ ...current, page, pageSize }))}
            aria-label={t('sql_audit.pagination.aria_label')}
          />
        </div>
      </section>

      <SqlAuditDetailDrawer
        event={selectedEvent}
        open={!!selectedEvent}
        onClose={() => setSelectedEvent(null)}
        backend={backend}
        connectionName={detailConnectionName}
        onRestore={handleRestoreEvent}
      />
      <SqlAuditSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => setReloadKey((current) => current + 1)}
        backend={backend}
      />
    </main>
  );
}
