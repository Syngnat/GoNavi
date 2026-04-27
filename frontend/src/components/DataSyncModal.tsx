import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Modal, Form, Select, Input, Button, message, Steps, Transfer, Card, Alert, Divider, Typography, Progress, Checkbox, Table, Drawer, Tabs, theme as antdTheme } from 'antd';
import { DatabaseOutlined, RocketOutlined, SwapOutlined, TableOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { DBGetDatabases, DBGetTables, DataSync, DataSyncAnalyze, DataSyncPreview } from '../../wailsjs/go/app/App';
import { SavedConnection } from '../types';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { isMacLikePlatform, normalizeOpacityForPlatform, resolveAppearanceValues, resolveTextInputSafeBackdropFilter } from '../utils/appearance';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { formatLocalDateTimeLiteral, normalizeTemporalLiteralText } from './dataGridCopyInsert';
import { buildDataSyncRequest, type SourceDatasetMode, validateDataSyncSelection } from './dataSyncRequest';

const { Title, Text } = Typography;
const { Step } = Steps;
const { Option } = Select;
const { TextArea } = Input;

type SyncLogEvent = { jobId: string; level?: string; message?: string; ts?: number };
type SyncProgressEvent = { jobId: string; percent?: number; current?: number; total?: number; table?: string; stage?: string };
type SyncLogItem = { level: string; message: string; ts?: number };
type TableDiffSummary = {
  table: string;
  pkColumn?: string;
  canSync?: boolean;
  inserts?: number;
  updates?: number;
  deletes?: number;
  same?: number;
  schemaDiffCount?: number;
  message?: string;
  targetTableExists?: boolean;
  plannedAction?: string;
  warnings?: string[];
  unsupportedObjects?: string[];
  indexesToCreate?: number;
  indexesSkipped?: number;
};
type TableOps = {
  insert: boolean;
  update: boolean;
  delete: boolean;
  selectedInsertPks?: string[];
  selectedUpdatePks?: string[];
  selectedDeletePks?: string[];
};

type WorkflowType = 'sync' | 'migration';

const quoteSqlIdent = (dbType: string, ident: string): string => {
  const raw = String(ident || '').trim();
  if (!raw) return raw;
  const t = String(dbType || '').toLowerCase();
  if (t === 'mysql' || t === 'mariadb' || t === 'diros' || t === 'sphinx' || t === 'clickhouse' || t === 'tdengine') {
    return `\`${raw.replace(/`/g, '``')}\``;
  }
  if (t === 'sqlserver') {
    return `[${raw.replace(/]/g, ']]')}]`;
  }
  return `"${raw.replace(/"/g, '""')}"`;
};

const quoteSqlTable = (dbType: string, tableName: string): string => {
  const raw = String(tableName || '').trim();
  if (!raw) return raw;
  if (!raw.includes('.')) return quoteSqlIdent(dbType, raw);
  return raw
    .split('.')
    .map((part) => quoteSqlIdent(dbType, part))
    .join('.');
};

const toSqlLiteral = (value: any, dbType: string): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') {
    const t = String(dbType || '').toLowerCase();
    if (t === 'sqlserver') return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }
  if (value instanceof Date) {
    return `'${formatLocalDateTimeLiteral(value).replace(/'/g, "''")}'`;
  }
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === 'object') {
    try {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    } catch {
      return `'${String(value).replace(/'/g, "''")}'`;
    }
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

const toTypedSqlLiteral = (value: any, dbType: string, columnType?: string): string => {
  if (typeof value === 'string') {
    const normalized = normalizeTemporalLiteralText(value, columnType, false);
    return toSqlLiteral(normalized, dbType);
  }
  if (value instanceof Date) {
    const normalized = String(columnType || '').trim()
      ? formatLocalDateTimeLiteral(value)
      : value.toISOString();
    return toSqlLiteral(normalized, dbType);
  }
  return toSqlLiteral(value, dbType);
};

const resolveRedisDbIndex = (raw?: string): number => {
  const value = Number(String(raw || '').trim());
  return Number.isInteger(value) && value >= 0 && value <= 15 ? value : 0;
};

const buildSqlPreview = (
  previewData: any,
  tableName: string,
  dbType: string,
  ops?: TableOps,
): { sqlText: string; statementCount: number } => {
  if (!previewData || !tableName) return { sqlText: '', statementCount: 0 };
  const tableExpr = quoteSqlTable(dbType, tableName);
  const pkCol = String(previewData.pkColumn || 'id');
  const columnTypesByLowerName = previewData?.columnTypes && typeof previewData.columnTypes === 'object'
    ? previewData.columnTypes as Record<string, string>
    : {};
  const statements: string[] = [];
  const schemaStatements = Array.isArray(previewData.schemaStatements)
    ? previewData.schemaStatements
        .map((item: any) => String(item || '').trim())
        .filter((item: string) => item.length > 0)
    : [];

  schemaStatements.forEach((statement: string) => {
    statements.push(statement.endsWith(';') ? statement : `${statement};`);
  });

  const insertRows = Array.isArray(previewData.inserts) ? previewData.inserts : [];
  const updateRows = Array.isArray(previewData.updates) ? previewData.updates : [];
  const deleteRows = Array.isArray(previewData.deletes) ? previewData.deletes : [];

  const selectedInsert = new Set((ops?.selectedInsertPks || []).map((v) => String(v)));
  const selectedUpdate = new Set((ops?.selectedUpdatePks || []).map((v) => String(v)));
  const selectedDelete = new Set((ops?.selectedDeletePks || []).map((v) => String(v)));

  if (ops?.insert !== false) {
    insertRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? '');
      if (selectedInsert.size > 0 && !selectedInsert.has(pk)) return;
      const row = rowWrap?.row || {};
      const columns = Object.keys(row);
      if (columns.length === 0) return;
      const colExpr = columns.map((c) => quoteSqlIdent(dbType, c)).join(', ');
      const valExpr = columns.map((c) => toTypedSqlLiteral(row[c], dbType, columnTypesByLowerName[String(c).toLowerCase()])).join(', ');
      statements.push(`INSERT INTO ${tableExpr} (${colExpr}) VALUES (${valExpr});`);
    });
  }

  if (ops?.update !== false) {
    updateRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? '');
      if (selectedUpdate.size > 0 && !selectedUpdate.has(pk)) return;
      const source = rowWrap?.source || {};
      const changedColumns = Array.isArray(rowWrap?.changedColumns)
        ? rowWrap.changedColumns
        : Object.keys(source).filter((k) => k !== pkCol);
      const setCols = changedColumns.filter((c: string) => String(c) !== pkCol);
      if (setCols.length === 0) return;
      const setExpr = setCols
        .map((c: string) => `${quoteSqlIdent(dbType, c)} = ${toTypedSqlLiteral(source[c], dbType, columnTypesByLowerName[String(c).toLowerCase()])}`)
        .join(', ');
      statements.push(
        `UPDATE ${tableExpr} SET ${setExpr} WHERE ${quoteSqlIdent(dbType, pkCol)} = ${toTypedSqlLiteral(pk, dbType, columnTypesByLowerName[String(pkCol).toLowerCase()])};`,
      );
    });
  }

  if (ops?.delete) {
    deleteRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? '');
      if (selectedDelete.size > 0 && !selectedDelete.has(pk)) return;
      statements.push(
        `DELETE FROM ${tableExpr} WHERE ${quoteSqlIdent(dbType, pkCol)} = ${toTypedSqlLiteral(pk, dbType, columnTypesByLowerName[String(pkCol).toLowerCase()])};`,
      );
    });
  }

  return {
    sqlText: statements.join('\n'),
    statementCount: statements.length,
  };
};

const DataSyncModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const connections = useStore((state) => state.connections);
  const themeMode = useStore((state) => state.theme);
  const appearance = useStore((state) => state.appearance);
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const { token } = antdTheme.useToken();
  const darkMode = themeMode === 'dark';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const effectiveOpacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const disableLocalBackdropFilter = isMacLikePlatform();
  
  // Step 1: Config
  const [sourceConnId, setSourceConnId] = useState<string>('');
  const [targetConnId, setTargetConnId] = useState<string>('');
  const [sourceDb, setSourceDb] = useState<string>('');
  const [targetDb, setTargetDb] = useState<string>('');
  
  const [sourceDbs, setSourceDbs] = useState<string[]>([]);
  const [targetDbs, setTargetDbs] = useState<string[]>([]);

  // Step 2: Tables
  const [allTables, setAllTables] = useState<string[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [sourceDatasetMode, setSourceDatasetMode] = useState<SourceDatasetMode>('table');
  const [sourceQuery, setSourceQuery] = useState<string>('');

  // Options
  const [workflowType, setWorkflowType] = useState<WorkflowType>('sync');
  const [syncContent, setSyncContent] = useState<'data' | 'schema' | 'both'>('data');
  const [syncMode, setSyncMode] = useState<string>('insert_update');
  const [autoAddColumns, setAutoAddColumns] = useState<boolean>(true);
  const [targetTableStrategy, setTargetTableStrategy] = useState<'existing_only' | 'auto_create_if_missing' | 'smart'>('existing_only');
  const [createIndexes, setCreateIndexes] = useState<boolean>(false);
  const [mongoCollectionName, setMongoCollectionName] = useState<string>('');
  const [showSameTables, setShowSameTables] = useState<boolean>(false);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [diffTables, setDiffTables] = useState<TableDiffSummary[]>([]);
  const [tableOptions, setTableOptions] = useState<Record<string, TableOps>>({});

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTable, setPreviewTable] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);

  // Step 3: Result
  const [syncResult, setSyncResult] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncLogs, setSyncLogs] = useState<SyncLogItem[]>([]);
  const [syncProgress, setSyncProgress] = useState<{ percent: number; current: number; total: number; table: string; stage: string }>({
      percent: 0,
      current: 0,
      total: 0,
      table: '',
      stage: ''
  });
  const jobIdRef = useRef<string>('');
  const logBoxRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const normalizeConnConfig = (conn: SavedConnection, database?: string) => (
      buildRpcConnectionConfig(conn.config, {
          database: typeof database === 'string' ? database : (conn.config.database || ''),
      })
  );

  useEffect(() => {
      if (!open) return;

      const offLog = EventsOn('sync:log', (event: SyncLogEvent) => {
          if (!event || event.jobId !== jobIdRef.current) return;
          const msg = String(event.message || '').trim();
          if (!msg) return;
          setSyncLogs(prev => [...prev, { level: String(event.level || 'info'), message: msg, ts: event.ts }]);
      });

      const offProgress = EventsOn('sync:progress', (event: SyncProgressEvent) => {
          if (!event || event.jobId !== jobIdRef.current) return;
          setSyncProgress(prev => ({
              percent: typeof event.percent === 'number' ? event.percent : prev.percent,
              current: typeof event.current === 'number' ? event.current : prev.current,
              total: typeof event.total === 'number' ? event.total : prev.total,
              table: typeof event.table === 'string' ? event.table : prev.table,
              stage: typeof event.stage === 'string' ? event.stage : prev.stage,
          }));
      });

      return () => {
          offLog();
          offProgress();
      };
  }, [open]);

  useEffect(() => {
      if (!logBoxRef.current) return;
      if (!autoScrollRef.current) return;
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [syncLogs]);

  useEffect(() => {
    if (open) {
        setCurrentStep(0);
        setSourceConnId('');
        setTargetConnId('');
        setSourceDb('');
        setTargetDb('');
        setAllTables([]);
        setSelectedTables([]);
        setSourceDatasetMode('table');
        setSourceQuery('');
        setWorkflowType('sync');
        setSyncContent('data');
        setSyncMode('insert_update');
        setAutoAddColumns(true);
        setTargetTableStrategy('existing_only');
        setCreateIndexes(false);
        setShowSameTables(false);
        setAnalyzing(false);
        setDiffTables([]);
        setTableOptions({});
        setPreviewOpen(false);
        setPreviewTable('');
        setPreviewLoading(false);
        setPreviewData(null);
        setSyncResult(null);
        setSyncing(false);
        setSyncLogs([]);
        setSyncProgress({ percent: 0, current: 0, total: 0, table: '', stage: '' });
        jobIdRef.current = '';
        autoScrollRef.current = true;
    }
  }, [open]);

  useEffect(() => {
      if (workflowType === 'migration') {
          if (syncMode === 'insert_update') {
              setSyncMode('insert_only');
          }
          if (syncContent === 'schema') {
              setSyncContent('both');
          }
          if (targetTableStrategy === 'existing_only') {
              setTargetTableStrategy('smart');
          }
          if (!createIndexes) {
              setCreateIndexes(true);
          }
      } else {
          if (targetTableStrategy !== 'existing_only') {
              setTargetTableStrategy('existing_only');
          }
          if (createIndexes) {
              setCreateIndexes(false);
          }
      }
  }, [workflowType]);

  useEffect(() => {
      if (sourceDatasetMode !== 'query') return;
      if (workflowType !== 'sync') {
          setWorkflowType('sync');
      }
      if (syncContent !== 'data') {
          setSyncContent('data');
      }
      if (targetTableStrategy !== 'existing_only') {
          setTargetTableStrategy('existing_only');
      }
      if (createIndexes) {
          setCreateIndexes(false);
      }
      if (autoAddColumns) {
          setAutoAddColumns(false);
      }
      if (selectedTables.length > 1) {
          setSelectedTables(selectedTables.slice(0, 1));
      }
  }, [sourceDatasetMode, workflowType, syncContent, targetTableStrategy, createIndexes, autoAddColumns, selectedTables]);

  const handleSourceConnChange = async (connId: string) => {
      setSourceConnId(connId);
      setSourceDb('');
      const conn = connections.find(c => c.id === connId);
	  if (conn) {
	      setLoading(true);
	      try {
	        const res = await DBGetDatabases(normalizeConnConfig(conn) as any);
	        if (res.success) {
	            const dbRows = Array.isArray(res.data) ? res.data : [];
	            setSourceDbs(dbRows
	                .map((r: any) => r?.Database || r?.database || r?.username)
	                .filter((name: any) => typeof name === 'string' && name.trim() !== ''));
	        }
	      } catch(e) { message.error("Failed to fetch source databases"); }
	      setLoading(false);
	  }
  };

  const handleTargetConnChange = async (connId: string) => {
      setTargetConnId(connId);
      setTargetDb('');
      const conn = connections.find(c => c.id === connId);
	  if (conn) {
	      setLoading(true);
	      try {
	        const res = await DBGetDatabases(normalizeConnConfig(conn) as any);
	        if (res.success) {
	            const dbRows = Array.isArray(res.data) ? res.data : [];
	            setTargetDbs(dbRows
	                .map((r: any) => r?.Database || r?.database || r?.username)
	                .filter((name: any) => typeof name === 'string' && name.trim() !== ''));
	        }
	      } catch(e) { message.error("Failed to fetch target databases"); }
	      setLoading(false);
	  }
  };

  const nextToTables = async () => {
      if (!sourceConnId || !targetConnId) return message.error("Select connections first");
      if (!sourceDb) return message.error("Select source database");
      if (!targetDb) return message.error("Select target database");

      setLoading(true);
      try {
          const connId = isSourceQueryMode ? targetConnId : sourceConnId;
          const dbName = isSourceQueryMode ? targetDb : sourceDb;
          const conn = connections.find(c => c.id === connId);
          if (conn) {
	          const config = normalizeConnConfig(conn, dbName);
	          const res = await DBGetTables(config as any, dbName);
	          if (res.success) {
	              // DBGetTables returns [{Table: "name"}, ...]
	              const tableRows = Array.isArray(res.data) ? res.data : [];
	              const tables = tableRows
	                  .map((row: any) => row?.Table || row?.table || row?.TABLE_NAME || Object.values(row || {})[0])
	                  .filter((name: any) => typeof name === 'string' && name.trim() !== '');
	              setAllTables(tables as string[]);
                  setSelectedTables(prev => {
                      const existing = prev.filter((name) => tables.includes(name));
                      if (isSourceQueryMode) {
                          return existing.slice(0, 1);
                      }
                      return existing;
                  });
	              setCurrentStep(1);
	          } else {
                  message.error(res.message);
              }
          }
      } catch (e) { message.error("Failed to fetch tables"); }
      setLoading(false);
  };

  const updateTableOption = (table: string, key: keyof TableOps, value: any) => {
      setTableOptions(prev => ({
          ...prev,
          [table]: { ...(prev[table] || { insert: true, update: true, delete: false }), [key]: value }
      }));
  };

  const analyzeDiff = async () => {
      const selectionError = validateDataSyncSelection({ sourceDatasetMode, selectedTables, sourceQuery, syncContent });
      if (selectionError) return message.error(selectionError);
      if (!sourceConnId || !targetConnId) return message.error("Select connections first");
      if (!sourceDb || !targetDb) return message.error("Select databases first");

      setLoading(true);
      setAnalyzing(true);
      setDiffTables([]);
      setTableOptions({});
      setSyncLogs([]);

      const sConn = connections.find(c => c.id === sourceConnId)!;
      const tConn = connections.find(c => c.id === targetConnId)!;
      const jobId = `analyze-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      jobIdRef.current = jobId;
      autoScrollRef.current = true;
      setSyncProgress({ percent: 0, current: 0, total: selectedTables.length, table: '', stage: '差异分析' });

      const config = buildDataSyncRequest({
          sourceConfig: normalizeConnConfig(sConn, sourceDb),
          targetConfig: normalizeConnConfig(tConn, targetDb),
          selectedTables,
          sourceDatasetMode,
          sourceQuery,
          syncContent,
          syncMode: "insert_update",
          autoAddColumns,
          targetTableStrategy,
          createIndexes,
          mongoCollectionName,
          jobId,
      });

      try {
          const res = await DataSyncAnalyze(config as any);
          if (res.success) {
              const tables = ((res.data as any)?.tables || []) as TableDiffSummary[];
              setDiffTables(tables);
              const init: Record<string, TableOps> = {};
              tables.forEach(t => {
                  const can = !!t.canSync;
                  init[t.table] = {
                      insert: can,
                      update: can,
                      delete: false,
                      selectedInsertPks: [],
                      selectedUpdatePks: [],
                      selectedDeletePks: [],
                  };
              });
              setTableOptions(init);
              message.success("差异分析完成");
          } else {
              message.error(res.message || "差异分析失败");
          }
      } catch (e: any) {
          message.error("差异分析失败: " + (e?.message || ""));
      }

      setLoading(false);
      setAnalyzing(false);
  };

  const openPreview = async (table: string) => {
      if (!table) return;
      const sConn = connections.find(c => c.id === sourceConnId)!;
      const tConn = connections.find(c => c.id === targetConnId)!;

      setPreviewOpen(true);
      setPreviewTable(table);
      setPreviewLoading(true);
      setPreviewData(null);

      const config = buildDataSyncRequest({
          sourceConfig: normalizeConnConfig(sConn, sourceDb),
          targetConfig: normalizeConnConfig(tConn, targetDb),
          selectedTables,
          sourceDatasetMode,
          sourceQuery,
          syncContent,
          syncMode: "insert_update",
          autoAddColumns,
          targetTableStrategy,
          createIndexes,
          mongoCollectionName,
      });

      try {
          const res = await DataSyncPreview(config as any, table, 200);
          if (res.success) {
              setPreviewData(res.data);
          } else {
              message.error(res.message || "加载差异预览失败");
          }
      } catch (e: any) {
          message.error("加载差异预览失败: " + (e?.message || ""));
      }

      setPreviewLoading(false);
  };

  const runSync = async () => {
      const selectionError = validateDataSyncSelection({ sourceDatasetMode, selectedTables, sourceQuery, syncContent });
      if (selectionError) {
          message.error(selectionError);
          return;
      }
      if (syncContent !== 'schema' && diffTables.length === 0) {
          message.error("请先对比差异，再开始同步");
          return;
      }
      if (syncContent !== 'schema' && syncMode === 'full_overwrite') {
          const ok = await new Promise<boolean>((resolve) => {
              Modal.confirm({
                  title: '确认全量覆盖',
                  content: '全量覆盖会清空目标表数据后再插入，请确认已备份目标库。',
                  okText: '继续执行',
                  cancelText: '取消',
                  onOk: () => resolve(true),
                  onCancel: () => resolve(false),
              });
          });
          if (!ok) return;
      }

      setLoading(true);
      setSyncing(true);
      setCurrentStep(2);
      setSyncResult(null);
      setSyncLogs([]);

      const sConn = connections.find(c => c.id === sourceConnId)!;
      const tConn = connections.find(c => c.id === targetConnId)!;

      const jobId = `sync-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      jobIdRef.current = jobId;
      autoScrollRef.current = true;
      setSyncProgress({
          percent: 0,
          current: 0,
          total: selectedTables.length,
          table: '',
          stage: '准备开始',
      });
      
      const config = buildDataSyncRequest({
          sourceConfig: normalizeConnConfig(sConn, sourceDb),
          targetConfig: normalizeConnConfig(tConn, targetDb),
          selectedTables,
          sourceDatasetMode,
          sourceQuery,
          syncContent,
          syncMode,
          autoAddColumns,
          targetTableStrategy,
          createIndexes,
          mongoCollectionName,
          tableOptions,
          jobId,
      });

      try {
          const res = await DataSync(config as any);
          setSyncResult(res);
          if (Array.isArray(res?.logs) && res.logs.length > 0) {
              setSyncLogs(prev => {
                  if (prev.length > 0) return prev;
                  return (res.logs as string[]).map((log) => {
                      const msg = String(log || '').trim();
                      if (msg.includes('致命错误') || msg.includes('失败')) return { level: 'error', message: msg };
                      if (msg.includes('跳过') || msg.includes('警告')) return { level: 'warn', message: msg };
                      return { level: 'info', message: msg };
                  });
              });
          }
      } catch (e) {
          message.error("Sync execution failed");
          setSyncResult({ success: false, message: "同步执行失败", logs: [] });
      }
      setLoading(false);
      setSyncing(false);
  };

  const renderSyncLogItem = (item: SyncLogItem) => {
      const level = String(item.level || 'info').toLowerCase();
      const color = level === 'error' ? '#ff4d4f' : (level === 'warn' ? '#faad14' : '#595959');
      const label = level === 'error' ? '错误' : (level === 'warn' ? '警告' : '信息');
      const timeText = typeof item.ts === 'number' ? new Date(item.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      return (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color, flex: '0 0 auto' }}>● {label}</span>
              {timeText && <span style={{ color: '#8c8c8c', flex: '0 0 auto' }}>{timeText}</span>}
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.message}</span>
          </div>
      );
  };

  const previewSql = useMemo(() => {
      if (!previewData || !previewTable) return { sqlText: '', statementCount: 0 };
      const targetType = String(connections.find(c => c.id === targetConnId)?.config?.type || '');
      const ops = tableOptions[previewTable] || { insert: true, update: true, delete: false };
      return buildSqlPreview(previewData, previewTable, targetType, ops);
  }, [previewData, previewTable, targetConnId, connections, tableOptions]);
  const previewHasSchemaStatements = useMemo(
      () => Array.isArray(previewData?.schemaStatements) && previewData.schemaStatements.length > 0,
      [previewData],
  );
  const previewSchemaWarnings = useMemo(
      () => Array.isArray(previewData?.schemaWarnings) ? previewData.schemaWarnings as string[] : [],
      [previewData],
  );
  const previewHasDataDiff = useMemo(
      () => Number(previewData?.totalInserts || 0) + Number(previewData?.totalUpdates || 0) + Number(previewData?.totalDeletes || 0) > 0,
      [previewData],
  );

  const analysisWarnings = useMemo(() => {
      const items: string[] = [];
      diffTables.forEach((table) => {
          (table.warnings || []).forEach((warning) => items.push(`${table.table}: ${warning}`));
          (table.unsupportedObjects || []).forEach((warning) => items.push(`${table.table}: ${warning}`));
      });
      return Array.from(new Set(items));
  }, [diffTables]);

  const isSourceQueryMode = sourceDatasetMode === 'query';
  const isMigrationWorkflow = workflowType === 'migration';
  const sourceConn = useMemo(() => connections.find(c => c.id === sourceConnId), [connections, sourceConnId]);
  const targetConn = useMemo(() => connections.find(c => c.id === targetConnId), [connections, targetConnId]);
  const sourceType = String(sourceConn?.config?.type || '').toLowerCase();
  const targetType = String(targetConn?.config?.type || '').toLowerCase();
  const isRedisMongoKeyspaceMigration = isMigrationWorkflow && (
      (sourceType === 'redis' && targetType === 'mongodb') ||
      (sourceType === 'mongodb' && targetType === 'redis')
  );
  const defaultMongoCollectionName = useMemo(() => {
      if (sourceType === 'redis' && targetType === 'mongodb') {
          return `redis_db_${resolveRedisDbIndex(sourceDb || sourceConn?.config?.database)}_keys`;
      }
      if (sourceType === 'mongodb' && targetType === 'redis') {
          return selectedTables[0] || `redis_db_${resolveRedisDbIndex(targetDb || targetConn?.config?.database)}_keys`;
      }
      return '';
  }, [sourceType, targetType, sourceDb, targetDb, sourceConn, targetConn, selectedTables]);

  const modalPanelStyle = useMemo(() => ({
      background: darkMode
          ? 'linear-gradient(180deg, rgba(16,22,34,0.96) 0%, rgba(10,14,24,0.98) 100%)'
          : 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(246,248,252,0.98) 100%)',
      border: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(16,24,40,0.08)',
      boxShadow: darkMode ? '0 24px 56px rgba(0,0,0,0.36)' : '0 18px 44px rgba(15,23,42,0.14)',
      backdropFilter: resolveTextInputSafeBackdropFilter(darkMode ? 'blur(18px)' : 'none', disableLocalBackdropFilter),
  }), [darkMode, disableLocalBackdropFilter]);

  const shellCardStyle = useMemo<React.CSSProperties>(() => ({
      borderRadius: 18,
      border: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.08)',
      background: darkMode ? 'rgba(255,255,255,0.03)' : `rgba(255,255,255,${Math.max(effectiveOpacity, 0.88)})`,
      boxShadow: darkMode ? '0 12px 32px rgba(0,0,0,0.22)' : '0 10px 24px rgba(15,23,42,0.08)',
      overflow: 'hidden',
  }), [darkMode, effectiveOpacity]);

  const heroPanelStyle = useMemo<React.CSSProperties>(() => ({
      padding: 18,
      borderRadius: 18,
      border: darkMode ? '1px solid rgba(255,214,102,0.12)' : '1px solid rgba(24,144,255,0.12)',
      background: darkMode
          ? 'linear-gradient(135deg, rgba(255,214,102,0.10) 0%, rgba(255,255,255,0.03) 100%)'
          : 'linear-gradient(135deg, rgba(24,144,255,0.10) 0%, rgba(255,255,255,0.95) 100%)',
      marginBottom: 18,
  }), [darkMode]);

  const badgeStyle = useMemo<React.CSSProperties>(() => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      borderRadius: 999,
      border: darkMode ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(15,23,42,0.08)',
      background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.86)',
      color: darkMode ? 'rgba(255,255,255,0.88)' : '#334155',
      fontSize: 12,
      fontWeight: 600,
  }), [darkMode]);

  const quietPanelStyle = useMemo<React.CSSProperties>(() => ({
      padding: 14,
      borderRadius: 16,
      border: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.08)',
      background: darkMode ? 'rgba(255,255,255,0.025)' : 'rgba(248,250,252,0.92)',
  }), [darkMode]);

  const modalWorkspaceStyle = useMemo<React.CSSProperties>(() => ({
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
  }), []);

  const modalScrollableContentStyle = useMemo<React.CSSProperties>(() => ({
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      paddingRight: 4,
      overscrollBehavior: 'contain',
  }), []);

  const modalFooterBarStyle = useMemo<React.CSSProperties>(() => ({
      marginTop: 18,
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      paddingTop: 12,
      borderTop: darkMode ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(15,23,42,0.06)',
      flex: '0 0 auto',
  }), [darkMode]);

  const renderModalTitle = (title: string, description: string) => (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
              width: 38,
              height: 38,
              borderRadius: 14,
              display: 'grid',
              placeItems: 'center',
              background: darkMode ? 'rgba(255,214,102,0.12)' : 'rgba(24,144,255,0.10)',
              color: darkMode ? '#ffd666' : token.colorPrimary,
              flexShrink: 0,
          }}>
              {isMigrationWorkflow ? <RocketOutlined /> : <SwapOutlined />}
          </div>
          <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: darkMode ? '#f8fafc' : '#0f172a' }}>{title}</div>
              <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.6, color: darkMode ? 'rgba(255,255,255,0.56)' : 'rgba(15,23,42,0.58)' }}>{description}</div>
          </div>
      </div>
  );

  return (
    <>
    <Modal
        title={renderModalTitle(isMigrationWorkflow ? '跨库迁移工作台' : '数据同步工作台', isMigrationWorkflow ? '按源库 → 目标库完成建表、导入与风险预检。' : '按已有目标表完成差异对比、同步执行与结果确认。')}
        open={open}
        onCancel={() => {
            if (syncing) {
                message.warning("同步执行中，暂不支持关闭");
                return;
            }
            onClose();
        }}
        width={920}
        footer={null}
        destroyOnHidden
        closable={!syncing}
        maskClosable={!syncing}
        styles={{
            content: modalPanelStyle,
            header: { background: 'transparent', borderBottom: 'none', paddingBottom: 10 },
            body: {
                paddingTop: 8,
                height: 760,
                maxHeight: 'calc(100vh - 120px)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
            },
            footer: { background: 'transparent', borderTop: 'none', paddingTop: 12 },
        }}
    >
      <div style={modalWorkspaceStyle}>
      <div style={{ flex: '0 0 auto' }}>
      <div style={heroPanelStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: darkMode ? '#f8fafc' : '#0f172a' }}>{isMigrationWorkflow ? '跨数据源迁移' : '数据同步'}</div>
                  <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.7, color: darkMode ? 'rgba(255,255,255,0.62)' : 'rgba(15,23,42,0.62)' }}>
                      {isMigrationWorkflow
                          ? '适合把源表迁移到另一套数据库，可按策略自动建表、导入数据并补建可兼容索引。'
                          : '适合目标表已存在的场景，先做差异分析，再按勾选执行插入、更新或删除。'}
                  </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <span style={badgeStyle}>{isMigrationWorkflow ? <RocketOutlined /> : <SwapOutlined />} {isMigrationWorkflow ? '迁移模式' : '同步模式'}</span>
                  <span style={badgeStyle}><DatabaseOutlined /> {sourceConnId ? '已选源连接' : '待选源连接'}</span>
                  <span style={badgeStyle}><TableOutlined /> {selectedTables.length || 0} 张表</span>
              </div>
          </div>
      </div>
      <Steps current={currentStep} style={{ marginBottom: 24 }}>
        <Step title="配置源与目标" />
        <Step title="选择表" />
        <Step title="执行结果" />
      </Steps>
      </div>

      <div style={modalScrollableContentStyle}>
      {/* STEP 1: CONFIG */}
      {currentStep === 0 && (
          <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 44px minmax(0, 1fr)', gap: 18, alignItems: 'stretch' }}>
                  <Card
                      title="源数据库"
                      style={shellCardStyle}
                      styles={{ header: { borderBottom: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.06)', fontWeight: 700 }, body: { padding: 18 } }}
                  >
                      <Form layout="vertical">
                          <Form.Item label="连接">
                              <Select value={sourceConnId} onChange={handleSourceConnChange}>
                                  {connections.map(c => <Option key={c.id} value={c.id}>{c.name} ({c.config.type})</Option>)}
                              </Select>
                          </Form.Item>
                          <Form.Item label="数据库">
                              <Select value={sourceDb} onChange={setSourceDb} showSearch>
                                  {sourceDbs.map(d => <Option key={d} value={d}>{d}</Option>)}
                              </Select>
                          </Form.Item>
                      </Form>
                  </Card>
                  <div style={{ display: 'grid', placeItems: 'center' }}>
                      <div style={{ ...badgeStyle, width: 44, height: 44, borderRadius: 14, justifyContent: 'center', padding: 0 }}>
                          <SwapOutlined />
                      </div>
                  </div>
                  <Card
                      title="目标数据库"
                      style={shellCardStyle}
                      styles={{ header: { borderBottom: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.06)', fontWeight: 700 }, body: { padding: 18 } }}
                  >
                      <Form layout="vertical">
                          <Form.Item label="连接">
                              <Select value={targetConnId} onChange={handleTargetConnChange}>
                                  {connections.map(c => <Option key={c.id} value={c.id}>{c.name} ({c.config.type})</Option>)}
                              </Select>
                          </Form.Item>
                          <Form.Item label="数据库">
                              <Select value={targetDb} onChange={setTargetDb} showSearch>
                                  {targetDbs.map(d => <Option key={d} value={d}>{d}</Option>)}
                              </Select>
                          </Form.Item>
                      </Form>
                  </Card>
              </div>

              <Card
                  title={isMigrationWorkflow ? '迁移选项' : '同步选项'}
                  style={{ ...shellCardStyle, marginTop: 18 }}
                  styles={{ header: { borderBottom: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.06)', fontWeight: 700 }, body: { padding: 18 } }}
              >
                  <div style={{ ...quietPanelStyle, marginBottom: 14 }}>
                      <Text style={{ color: darkMode ? 'rgba(255,255,255,0.72)' : 'rgba(15,23,42,0.68)', lineHeight: 1.7 }}>
                          先明确当前要做的是“已有目标表同步”还是“跨库迁移”，页面会按功能类型自动给出更安全的默认策略。
                      </Text>
                  </div>
                  <Form layout="vertical">
                      <Form.Item label="功能类型">
                          <Select value={workflowType} onChange={setWorkflowType}>
                              <Option value="sync">数据同步（基于已有目标表做差异同步）</Option>
                              <Option value="migration" disabled={isSourceQueryMode}>跨库迁移（可自动建表后导入）</Option>
                          </Select>
                      </Form.Item>
                      <Form.Item label="源数据方式">
                          <Select value={sourceDatasetMode} onChange={setSourceDatasetMode}>
                              <Option value="table">按表同步</Option>
                              <Option value="query">按 SQL 结果集同步</Option>
                          </Select>
                      </Form.Item>
                      <Alert
                          type={isMigrationWorkflow ? 'info' : 'success'}
                          showIcon
                          style={{ marginBottom: 12 }}
                          message={isMigrationWorkflow
                              ? '当前为“跨库迁移”模式：适合将表迁移到另一数据源，可自动建表并导入数据。'
                              : '当前为“数据同步”模式：适合目标表已存在时做增量同步或覆盖导入。'}
                      />
                      {isSourceQueryMode && (
                          <Alert
                              type="info"
                              showIcon
                              style={{ marginBottom: 12 }}
                              message="SQL 结果集同步当前只支持：源端自定义 SQL -> 单个已存在目标表；查询结果需包含目标表主键列。"
                          />
                      )}
                      <Form.Item label={isMigrationWorkflow ? '迁移内容' : '同步内容'}>
                          <Select value={syncContent} onChange={setSyncContent}>
                              <Option value="data">仅同步数据</Option>
                              <Option value="schema" disabled={isSourceQueryMode}>仅同步结构</Option>
                              <Option value="both" disabled={isSourceQueryMode}>同步结构 + 数据</Option>
                          </Select>
                      </Form.Item>
                      <Form.Item label={isMigrationWorkflow ? '迁移模式' : '同步模式'}>
                          <Select value={syncMode} onChange={setSyncMode} disabled={syncContent === 'schema'}>
                              <Option value="insert_update">增量同步（对比差异，按插入/更新/删除勾选执行）</Option>
                              <Option value="insert_only">仅插入（不对比目标；无主键表将跳过）</Option>
                              <Option value="full_overwrite">全量覆盖（清空目标表后插入）</Option>
                          </Select>
                      </Form.Item>
                      <Form.Item label={isMigrationWorkflow ? '目标表处理策略' : '目标表要求'}>
                          <Select value={targetTableStrategy} onChange={setTargetTableStrategy} disabled={!isMigrationWorkflow || isSourceQueryMode}>
                              <Option value="existing_only">仅使用已有目标表</Option>
                              <Option value="auto_create_if_missing">目标表不存在时自动建表后导入</Option>
                              <Option value="smart">智能模式（存在则直接导入，不存在则自动建表）</Option>
                          </Select>
                      </Form.Item>
                      {isRedisMongoKeyspaceMigration && (
                          <Form.Item
                              label="Mongo 集合名（可选）"
                              extra={sourceType === 'redis'
                                  ? '为空时沿用默认集合名；填写后本次 Redis 键空间会统一写入该 Mongo 集合。'
                                  : 'MongoDB → Redis 场景下通常直接选择源集合；这里留空即可，未显式选集合时才会回退使用该名称。'}
                          >
                              <Input
                                  value={mongoCollectionName}
                                  onChange={(e) => setMongoCollectionName(e.target.value)}
                                  placeholder={defaultMongoCollectionName || '请输入 Mongo 集合名'}
                                  allowClear
                                  maxLength={128}
                              />
                          </Form.Item>
                      )}
                      <Form.Item>
                          <Checkbox checked={autoAddColumns} onChange={(e) => setAutoAddColumns(e.target.checked)} disabled={isSourceQueryMode}>
                              自动补齐目标表缺失字段（当前支持 MySQL 目标及 MySQL → Kingbase；SQL 结果集模式暂不支持）
                          </Checkbox>
                      </Form.Item>
                      <Form.Item>
                          <Checkbox checked={createIndexes} onChange={(e) => setCreateIndexes(e.target.checked)} disabled={!isMigrationWorkflow || targetTableStrategy === 'existing_only' || isSourceQueryMode}>
                              自动迁移可兼容的普通索引/唯一索引（仅自动建表模式生效）
                          </Checkbox>
                      </Form.Item>
                      {isMigrationWorkflow && targetTableStrategy !== 'existing_only' && (
                          <Alert
                              type="info"
                              showIcon
                              message="自动建表模式现已支持 MySQL → PostgreSQL 系列，以及 PostgreSQL 系列之间互转；将迁移字段、主键、普通/唯一/联合索引，并显式跳过全文、空间、前缀、函数类索引。"
                              style={{ marginBottom: 12 }}
                          />
                      )}
                      {!isMigrationWorkflow && (
                          <Alert
                              type="info"
                              showIcon
                              message="数据同步模式默认基于已有目标表执行；如需跨数据源建表导入，请切换到“跨库迁移”。"
                              style={{ marginBottom: 12 }}
                          />
                      )}
                      {syncContent !== 'schema' && syncMode === 'full_overwrite' && (
                          <Alert
                              type="warning"
                              showIcon
                              message="全量覆盖会清空目标表数据，请谨慎使用。"
                          />
                      )}
                  </Form>
              </Card>
          </div>
      )}

      {/* STEP 2: TABLES */}
      {currentStep === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={quietPanelStyle}>
                  {!isSourceQueryMode && (
                      <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                              <Text type="secondary">请选择需要同步的表：</Text>
                              <Checkbox checked={showSameTables} onChange={(e) => setShowSameTables(e.target.checked)}>
                                  显示相同表
                              </Checkbox>
                          </div>
                          <Transfer
                              dataSource={allTables.map(t => ({ key: t, title: t }))}
                              titles={['源表', '已选表']}
                              targetKeys={selectedTables}
                              onChange={(keys) => setSelectedTables(keys as string[])}
                              render={item => item.title}
                              listStyle={{ width: 390, height: 320, marginTop: 0, borderRadius: 14, overflow: 'hidden' }}
                              locale={{ itemUnit: '项', itemsUnit: '项', searchPlaceholder: '搜索表…', notFoundContent: '暂无数据' }}
                          />
                      </>
                  )}
                  {isSourceQueryMode && (
                      <Form layout="vertical">
                          <Alert
                              type="info"
                              showIcon
                              style={{ marginBottom: 12 }}
                              message="请输入源查询 SQL，并选择一个目标表。差异分析会直接基于该结果集与目标表对比。"
                          />
                          <Form.Item label="源查询 SQL">
                              <TextArea
                                  value={sourceQuery}
                                  onChange={(e) => setSourceQuery(e.target.value)}
                                  rows={8}
                                  placeholder="例如：SELECT id, name, email FROM users WHERE status = 'active'"
                                  spellCheck={false}
                              />
                          </Form.Item>
                          <Form.Item label="目标表">
                              <Select
                                  value={selectedTables[0]}
                                  onChange={(value) => setSelectedTables(value ? [value] : [])}
                                  showSearch
                                  allowClear
                                  placeholder="请选择一个目标表"
                                  optionFilterProp="children"
                              >
                                  {allTables.map((table) => <Option key={table} value={table}>{table}</Option>)}
                              </Select>
                          </Form.Item>
                      </Form>
                  )}
              </div>

              {diffTables.length > 0 && (
                  <div style={quietPanelStyle}>
                      <Divider orientation="left" style={{ marginTop: 0 }}>对比结果</Divider>
                      {analysisWarnings.length > 0 && (
                          <Alert
                              type="warning"
                              showIcon
                              message="预检发现风险或降级项，请在执行前确认"
                              description={
                                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                                      {analysisWarnings.slice(0, 8).map((item) => <li key={item}>{item}</li>)}
                                      {analysisWarnings.length > 8 && <li>还有 {analysisWarnings.length - 8} 项未展开</li>}
                                  </ul>
                              }
                              style={{ marginBottom: 12 }}
                          />
                      )}
                      <Table
                          size="small"
                          pagination={false}
                          rowKey={(r: any) => r.table}
                          dataSource={diffTables.filter(t => {
                              const ins = Number(t.inserts || 0);
                              const upd = Number(t.updates || 0);
                              const del = Number(t.deletes || 0);
                              const same = Number(t.same || 0);
                              const msg = String(t.message || '').trim();
                              const can = !!t.canSync;
                              const warns = Array.isArray(t.warnings) ? t.warnings.length : 0;
                              const unsupported = Array.isArray(t.unsupportedObjects) ? t.unsupportedObjects.length : 0;
                              if (showSameTables) return true;
                              if (!can) return true;
                              if (msg || warns > 0 || unsupported > 0) return true;
                              return ins > 0 || upd > 0 || del > 0 || same === 0;
                          })}
                          columns={[
                              { title: '表名', dataIndex: 'table', key: 'table', ellipsis: true },
                              {
                                  title: '目标表',
                                  key: 'targetTableExists',
                                  width: 90,
                                  render: (_: any, r: any) => r.targetTableExists ? '已存在' : '不存在'
                              },
                              {
                                  title: '计划',
                                  dataIndex: 'plannedAction',
                                  key: 'plannedAction',
                                  width: 220,
                                  ellipsis: true,
                                  render: (v: any) => String(v || '')
                              },
                              {
                                  title: '插入',
                                  key: 'inserts',
                                  width: 90,
                                  render: (_: any, r: any) => {
                                      const ops = tableOptions[r.table] || { insert: true, update: true, delete: false };
                                      const disabled = !r.canSync || analyzing || Number(r.inserts || 0) === 0;
                                      return (
                                          <Checkbox checked={!!ops.insert} disabled={disabled} onChange={(e) => updateTableOption(r.table, 'insert', e.target.checked)}>
                                              {Number(r.inserts || 0)}
                                          </Checkbox>
                                      );
                                  }
                              },
                              {
                                  title: '更新',
                                  key: 'updates',
                                  width: 90,
                                  render: (_: any, r: any) => {
                                      const ops = tableOptions[r.table] || { insert: true, update: true, delete: false };
                                      const disabled = !r.canSync || analyzing || Number(r.updates || 0) === 0;
                                      return (
                                          <Checkbox checked={!!ops.update} disabled={disabled} onChange={(e) => updateTableOption(r.table, 'update', e.target.checked)}>
                                              {Number(r.updates || 0)}
                                          </Checkbox>
                                      );
                                  }
                              },
                              {
                                  title: '删除',
                                  key: 'deletes',
                                  width: 90,
                                  render: (_: any, r: any) => {
                                      const ops = tableOptions[r.table] || { insert: true, update: true, delete: false };
                                      const disabled = !r.canSync || analyzing || Number(r.deletes || 0) === 0;
                                      return (
                                          <Checkbox checked={!!ops.delete} disabled={disabled} onChange={(e) => updateTableOption(r.table, 'delete', e.target.checked)}>
                                              {Number(r.deletes || 0)}
                                          </Checkbox>
                                      );
                                  }
                              },
                              { title: '相同', dataIndex: 'same', key: 'same', width: 70, render: (v: any) => Number(v || 0) },
                              {
                                  title: '风险',
                                  key: 'warnings',
                                  width: 220,
                                  render: (_: any, r: any) => {
                                      const warns = [...(Array.isArray(r.warnings) ? r.warnings : []), ...(Array.isArray(r.unsupportedObjects) ? r.unsupportedObjects : [])];
                                      if (warns.length === 0) return '-';
                                      return (
                                          <div style={{ color: '#d48806', fontSize: 12, lineHeight: 1.5 }}>
                                              {warns.slice(0, 2).map((item: string) => <div key={item}>{item}</div>)}
                                              {warns.length > 2 && <div>还有 {warns.length - 2} 项</div>}
                                          </div>
                                      );
                                  }
                              },
                              {
                                  title: '预览',
                                  key: 'preview',
                                  width: 80,
                                  render: (_: any, r: any) => {
                                      const can = !!r.canSync;
                                      const hasDiff = Number(r.inserts || 0) + Number(r.updates || 0) + Number(r.deletes || 0) > 0;
                                      const hasSchemaDiff = Number(r.schemaDiffCount || 0) > 0;
                                      return (
                                          <Button size="small" disabled={!can || !(hasDiff || hasSchemaDiff) || analyzing} onClick={() => openPreview(r.table)}>
                                              查看
                                          </Button>
                                      );
                                  }
                              }
                          ]}
                      />
                  </div>
              )}
          </div>
      )}

      {/* STEP 3: RESULT */}
      {currentStep === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={quietPanelStyle}>
              <Alert
                  message={syncing ? "正在同步" : (syncResult?.success ? "同步完成" : "同步失败")}
                  description={
                      syncing
                          ? `当前阶段：${syncProgress.stage || '执行中'}${syncProgress.table ? `，表：${syncProgress.table}` : ''}`
                          : (syncResult?.message || `成功同步 ${syncResult?.tablesSynced || 0} 张表. 插入: ${syncResult?.rowsInserted || 0}, 更新: ${syncResult?.rowsUpdated || 0}`)
                  }
                  type={syncing ? "info" : (syncResult?.success ? "success" : "error")}
                  showIcon
              />

              <div style={{ marginTop: 14 }}>
                  <Progress
                      percent={syncProgress.percent}
                      status={syncing ? "active" : (syncResult?.success ? "success" : "exception")}
                      format={() => `${syncProgress.current}/${syncProgress.total}`}
                  />
              </div>

              </div>
              <div style={quietPanelStyle}>
              <Divider orientation="left" style={{ marginTop: 0 }}>执行日志</Divider>
              <div
                  ref={logBoxRef}
                  onScroll={() => {
                      const el = logBoxRef.current;
                      if (!el) return;
                      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                      autoScrollRef.current = nearBottom;
                  }}
                  style={{
                      background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(248,250,252,0.92)',
                      border: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.06)',
                      borderRadius: 14,
                      padding: 12,
                      height: 300,
                      overflowY: 'auto',
                      fontFamily: 'SFMono-Regular, ui-monospace, Menlo, Consolas, monospace'
                  }}
              >
                  {syncLogs.map((item, i: number) => <div key={i}>{renderSyncLogItem(item)}</div>)}
              </div>
              </div>
          </div>
      )}

      </div>

      <div style={modalFooterBarStyle}>
          {currentStep === 0 && (
              <Button type="primary" onClick={nextToTables} loading={loading}>下一步</Button>
          )}
	          {currentStep === 1 && (
	              <>
	                <Button onClick={() => setCurrentStep(0)} style={{ marginRight: 8 }}>上一步</Button>
	                <Button onClick={analyzeDiff} loading={loading} disabled={syncContent === 'schema' || selectedTables.length === 0 || analyzing || (isSourceQueryMode && !sourceQuery.trim())} style={{ marginRight: 8 }}>
	                    对比差异
	                </Button>
	                <Button
	                    type="primary"
	                    onClick={runSync}
                    loading={loading}
                    disabled={selectedTables.length === 0 || (isSourceQueryMode && !sourceQuery.trim()) || (syncContent !== 'schema' && diffTables.length === 0)}
                >
                    开始同步
                </Button>
              </>
          )}
          {currentStep === 2 && (
              <>
                  <Button disabled={syncing} onClick={() => setCurrentStep(1)} style={{ marginRight: 8 }}>继续同步</Button>
                  <Button type="primary" disabled={syncing} onClick={onClose}>关闭</Button>
              </>
          )}
      </div>
      </div>
    </Modal>
    <Drawer
        title={`差异预览：${previewTable}`}
        styles={{ body: { background: darkMode ? 'rgba(9,13,20,0.98)' : '#f8fafc' } }}
        open={previewOpen}
        onClose={() => { setPreviewOpen(false); setPreviewTable(''); setPreviewData(null); }}
        width={900}
    >
        {previewLoading && <Alert type="info" showIcon message="正在加载差异预览…" />}
        {!previewLoading && previewData && (
            <div>
                <Alert
                    type="info"
                    showIcon
                    message={
                        previewHasDataDiff
                            ? `插入 ${previewData.totalInserts || 0}，更新 ${previewData.totalUpdates || 0}，删除 ${previewData.totalDeletes || 0}（预览最多展示 200 条/类型）`
                            : (previewData.schemaSummary || `检测到 ${previewSql.statementCount} 条结构变更语句`)
                    }
                />
                {previewSchemaWarnings.length > 0 && (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="warning"
                        showIcon
                        message="结构预览包含风险或降级项"
                        description={
                            <ul style={{ margin: 0, paddingLeft: 18 }}>
                                {previewSchemaWarnings.slice(0, 8).map((item) => <li key={item}>{item}</li>)}
                                {previewSchemaWarnings.length > 8 && <li>还有 {previewSchemaWarnings.length - 8} 项未展开</li>}
                            </ul>
                        }
                    />
                )}
                <Divider />
                <Tabs
                    items={[
                        ...(previewHasSchemaStatements ? [{
                            key: 'schema',
                            label: `结构(${Array.isArray(previewData.schemaStatements) ? previewData.schemaStatements.length : 0})`,
                            children: (
                                <div>
                                    <Text type="secondary">
                                        {previewData.schemaSummary || '以下为本次结构同步计划执行的语句。'}
                                    </Text>
                                    <pre
                                        style={{
                                            marginTop: 8,
                                            marginBottom: 0,
                                            padding: 10,
                                            border: '1px solid #f0f0f0',
                                            borderRadius: 6,
                                            background: '#fafafa',
                                            maxHeight: 420,
                                            overflow: 'auto',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word'
                                        }}
                                    >
                                        {Array.isArray(previewData.schemaStatements) && previewData.schemaStatements.length > 0
                                            ? previewData.schemaStatements.join('\n')
                                            : '-- 当前表结构无可执行变更'}
                                    </pre>
                                </div>
                            )
                        }] : []),
                        ...(previewHasDataDiff ? [{
                            key: 'insert',
                            label: `插入(${previewData.totalInserts || 0})`,
                            children: (
                                <div>
                                    <Text type="secondary">未勾选任何行表示“同步全部插入差异”；如不想执行插入请在对比结果中取消勾选“插入”。</Text>
                                    <Table
                                        size="small"
                                        style={{ marginTop: 8 }}
                                        rowKey={(r: any) => r.pk}
                                        dataSource={(previewData.inserts || []).map((r: any) => ({ ...r, key: r.pk }))}
                                        pagination={false}
                                        rowSelection={{
                                            selectedRowKeys: (tableOptions[previewTable]?.selectedInsertPks || []) as any,
                                            onChange: (keys) => updateTableOption(previewTable, 'selectedInsertPks', keys as string[]),
                                            getCheckboxProps: () => ({ disabled: !tableOptions[previewTable]?.insert }),
                                        }}
                                        columns={[
                                            { title: previewData.pkColumn || '主键', dataIndex: 'pk', key: 'pk', width: 200, ellipsis: true },
                                            { title: '数据', dataIndex: 'row', key: 'row', render: (v: any) => <pre style={{ margin: 0, maxHeight: 140, overflow: 'auto' }}>{JSON.stringify(v, null, 2)}</pre> }
                                        ]}
                                    />
                                </div>
                            )
                        },
                        {
                            key: 'update',
                            label: `更新(${previewData.totalUpdates || 0})`,
                            children: (
                                <div>
                                    <Text type="secondary">未勾选任何行表示“同步全部更新差异”；如不想执行更新请在对比结果中取消勾选“更新”。</Text>
                                    <Table
                                        size="small"
                                        style={{ marginTop: 8 }}
                                        rowKey={(r: any) => r.pk}
                                        dataSource={(previewData.updates || []).map((r: any) => ({ ...r, key: r.pk }))}
                                        pagination={false}
                                        rowSelection={{
                                            selectedRowKeys: (tableOptions[previewTable]?.selectedUpdatePks || []) as any,
                                            onChange: (keys) => updateTableOption(previewTable, 'selectedUpdatePks', keys as string[]),
                                            getCheckboxProps: () => ({ disabled: !tableOptions[previewTable]?.update }),
                                        }}
                                        columns={[
                                            { title: previewData.pkColumn || '主键', dataIndex: 'pk', key: 'pk', width: 200, ellipsis: true },
                                            { title: '变更字段', dataIndex: 'changedColumns', key: 'changedColumns', render: (v: any) => Array.isArray(v) ? v.join(', ') : '' },
                                            {
                                                title: '详情',
                                                key: 'detail',
                                                width: 80,
                                                render: (_: any, r: any) => (
                                                    <Button size="small" onClick={() => {
                                                        Modal.info({
                                                            title: `更新详情：${previewTable} / ${r.pk}`,
                                                            width: 900,
                                                            content: (
                                                                <div style={{ display: 'flex', gap: 12 }}>
                                                                    <div style={{ flex: 1 }}>
                                                                        <Title level={5}>源</Title>
                                                                        <pre style={{ maxHeight: 360, overflow: 'auto', background: '#f5f5f5', padding: 8 }}>{JSON.stringify(r.source, null, 2)}</pre>
                                                                    </div>
                                                                    <div style={{ flex: 1 }}>
                                                                        <Title level={5}>目标</Title>
                                                                        <pre style={{ maxHeight: 360, overflow: 'auto', background: '#f5f5f5', padding: 8 }}>{JSON.stringify(r.target, null, 2)}</pre>
                                                                    </div>
                                                                </div>
                                                            )
                                                        });
                                                    }}>查看</Button>
                                                )
                                            }
                                        ]}
                                    />
                                </div>
                            )
                        },
                        {
                            key: 'delete',
                            label: `删除(${previewData.totalDeletes || 0})`,
                            children: (
                                <div>
                                    <Alert type="warning" showIcon message="删除默认不勾选。请确认业务允许后再开启删除操作。" />
                                    <Text type="secondary">未勾选任何行表示“同步全部删除差异”；如不想执行删除请在对比结果中取消勾选“删除”。</Text>
                                    <Table
                                        size="small"
                                        style={{ marginTop: 8 }}
                                        rowKey={(r: any) => r.pk}
                                        dataSource={(previewData.deletes || []).map((r: any) => ({ ...r, key: r.pk }))}
                                        pagination={false}
                                        rowSelection={{
                                            selectedRowKeys: (tableOptions[previewTable]?.selectedDeletePks || []) as any,
                                            onChange: (keys) => updateTableOption(previewTable, 'selectedDeletePks', keys as string[]),
                                            getCheckboxProps: () => ({ disabled: !tableOptions[previewTable]?.delete }),
                                        }}
                                        columns={[
                                            { title: previewData.pkColumn || '主键', dataIndex: 'pk', key: 'pk', width: 200, ellipsis: true },
                                            { title: '数据', dataIndex: 'row', key: 'row', render: (v: any) => <pre style={{ margin: 0, maxHeight: 140, overflow: 'auto' }}>{JSON.stringify(v, null, 2)}</pre> }
                                        ]}
                                    />
                                </div>
                            )
                        }] : []),
                        {
                            key: 'sql',
                            label: `SQL(${previewSql.statementCount})`,
                            children: (
                                <div>
                                    <Alert
                                        type="info"
                                        showIcon
                                        message={
                                            previewHasDataDiff
                                                ? "SQL 预览会按当前勾选的插入/更新/删除与行选择范围生成，用于审核确认。"
                                                : "SQL 预览展示将执行的结构变更语句，用于审核确认。"
                                        }
                                    />
                                    <div style={{ marginTop: 8, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <Text type="secondary">
                                            {previewHasDataDiff
                                                ? `共 ${previewSql.statementCount} 条语句（预览数据最多 200 条/类型）`
                                                : `共 ${previewSql.statementCount} 条结构变更语句`}
                                        </Text>
                                        <Button
                                            size="small"
                                            disabled={!previewSql.sqlText}
                                            onClick={async () => {
                                                try {
                                                    await navigator.clipboard.writeText(previewSql.sqlText || '');
                                                    message.success('SQL 已复制');
                                                } catch {
                                                    message.error('复制失败，请手动复制');
                                                }
                                            }}
                                        >
                                            复制 SQL
                                        </Button>
                                    </div>
                                    <pre
                                        style={{
                                            margin: 0,
                                            padding: 10,
                                            border: '1px solid #f0f0f0',
                                            borderRadius: 6,
                                            background: '#fafafa',
                                            maxHeight: 420,
                                            overflow: 'auto',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word'
                                        }}
                                    >
                                        {previewSql.sqlText || (previewHasDataDiff ? '-- 当前勾选范围下无 SQL 可预览' : '-- 当前表结构无可执行变更')}
                                    </pre>
                                </div>
                            )
                        }
                    ]}
                />
            </div>
        )}
    </Drawer>
    </>
  );
};

export default DataSyncModal;
