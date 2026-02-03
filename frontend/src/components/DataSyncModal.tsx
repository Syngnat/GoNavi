import React, { useState, useEffect, useRef } from 'react';
import { Modal, Form, Select, Button, message, Steps, Transfer, Card, Alert, Divider, Typography, Progress, Checkbox, Table, Drawer, Tabs } from 'antd';
import { useStore } from '../store';
import { DBGetDatabases, DBGetTables, DataSync, DataSyncAnalyze, DataSyncPreview } from '../../wailsjs/go/app/App';
import { SavedConnection } from '../types';
import { EventsOn } from '../../wailsjs/runtime/runtime';

const { Title, Text } = Typography;
const { Step } = Steps;
const { Option } = Select;

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
  message?: string;
};
type TableOps = {
  insert: boolean;
  update: boolean;
  delete: boolean;
  selectedInsertPks?: string[];
  selectedUpdatePks?: string[];
  selectedDeletePks?: string[];
};

const DataSyncModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const connections = useStore((state) => state.connections);
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  
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

  // Options
  const [syncContent, setSyncContent] = useState<'data' | 'schema' | 'both'>('data');
  const [syncMode, setSyncMode] = useState<string>('insert_update');
  const [autoAddColumns, setAutoAddColumns] = useState<boolean>(true);
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

  const normalizeConnConfig = (conn: SavedConnection, database?: string) => ({
      ...conn.config,
      port: Number((conn.config as any).port),
      password: conn.config.password || "",
      useSSH: conn.config.useSSH || false,
      ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" },
      database: typeof database === 'string' ? database : (conn.config.database || ""),
  });

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
        setSelectedTables([]);
        setSyncContent('data');
        setSyncMode('insert_update');
        setAutoAddColumns(true);
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

  const handleSourceConnChange = async (connId: string) => {
      setSourceConnId(connId);
      setSourceDb('');
      const conn = connections.find(c => c.id === connId);
      if (conn) {
          setLoading(true);
          try {
            const res = await DBGetDatabases(normalizeConnConfig(conn) as any);
            if (res.success) {
                setSourceDbs((res.data as any[]).map((r: any) => r.Database || r.database || r.username));
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
                setTargetDbs((res.data as any[]).map((r: any) => r.Database || r.database || r.username));
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
          const conn = connections.find(c => c.id === sourceConnId);
          if (conn) {
              const config = normalizeConnConfig(conn, sourceDb);
              const res = await DBGetTables(config as any, sourceDb);
              if (res.success) {
                  // DBGetTables returns [{Table: "name"}, ...]
                  const tables = (res.data as any[]).map((row: any) => row.Table || row.table || row.TABLE_NAME || Object.values(row)[0]);
                  setAllTables(tables as string[]);
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
      if (selectedTables.length === 0) return;
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

      const config = {
          sourceConfig: normalizeConnConfig(sConn, sourceDb),
          targetConfig: normalizeConnConfig(tConn, targetDb),
          tables: selectedTables,
          content: syncContent,
          mode: "insert_update",
          autoAddColumns,
          jobId,
      };

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

      const config = {
          sourceConfig: normalizeConnConfig(sConn, sourceDb),
          targetConfig: normalizeConnConfig(tConn, targetDb),
          tables: selectedTables,
          content: "data",
          mode: "insert_update",
          autoAddColumns,
      };

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
      
      const config = {
          sourceConfig: {
              ...sConn.config,
              port: Number((sConn.config as any).port),
              password: sConn.config.password || "",
              useSSH: sConn.config.useSSH || false,
              ssh: sConn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" },
              database: sourceDb,
          },
          targetConfig: {
              ...tConn.config,
              port: Number((tConn.config as any).port),
              password: tConn.config.password || "",
              useSSH: tConn.config.useSSH || false,
              ssh: tConn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" },
              database: targetDb,
          },
          tables: selectedTables,
          content: syncContent,
          mode: syncMode,
          autoAddColumns,
          tableOptions,
          jobId,
      };

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

  return (
    <>
    <Modal
        title="数据同步"
        open={open}
        onCancel={() => {
            if (syncing) {
                message.warning("同步执行中，暂不支持关闭");
                return;
            }
            onClose();
        }}
        width={800}
        footer={null}
        destroyOnHidden
        closable={!syncing}
        maskClosable={!syncing}
    >
      <Steps current={currentStep} style={{ marginBottom: 24 }}>
        <Step title="配置源与目标" />
        <Step title="选择表" />
        <Step title="执行结果" />
      </Steps>

      {/* STEP 1: CONFIG */}
      {currentStep === 0 && (
          <div>
              <div style={{ display: 'flex', gap: 24, justifyContent: 'center' }}>
                  <Card title="源数据库" style={{ width: 350 }}>
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
                  <div style={{ display: 'flex', alignItems: 'center' }}>至</div>
                  <Card title="目标数据库" style={{ width: 350 }}>
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

              <Card title="同步选项" style={{ marginTop: 16 }}>
                  <Form layout="vertical">
                      <Form.Item label="同步内容">
                          <Select value={syncContent} onChange={setSyncContent}>
                              <Option value="data">仅同步数据</Option>
                              <Option value="schema">仅同步结构</Option>
                              <Option value="both">同步结构 + 数据</Option>
                          </Select>
                      </Form.Item>
                      <Form.Item label="同步模式">
                          <Select value={syncMode} onChange={setSyncMode} disabled={syncContent === 'schema'}>
                              <Option value="insert_update">增量同步（对比差异，按插入/更新/删除勾选执行）</Option>
                              <Option value="insert_only">仅插入（不对比目标；无主键表将跳过）</Option>
                              <Option value="full_overwrite">全量覆盖（清空目标表后插入）</Option>
                          </Select>
                      </Form.Item>
                      <Form.Item>
                          <Checkbox checked={autoAddColumns} onChange={(e) => setAutoAddColumns(e.target.checked)}>
                              自动补齐目标表缺失字段（仅 MySQL 目标）
                          </Checkbox>
                      </Form.Item>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text type="secondary">请选择需要同步的表:</Text>
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
                listStyle={{ width: 350, height: 280, marginTop: 0 }}
                locale={{ itemUnit: '项', itemsUnit: '项', searchPlaceholder: '搜索表', notFoundContent: '暂无数据' }}
              />

              {diffTables.length > 0 && (
                  <div>
                      <Divider orientation="left">对比结果</Divider>
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
                              if (showSameTables) return true;
                              if (!can) return true;
                              if (msg) return true;
                              return ins > 0 || upd > 0 || del > 0 || same === 0;
                          })}
                          columns={[
                              { title: '表名', dataIndex: 'table', key: 'table', ellipsis: true },
                              {
                                  title: '插入',
                                  key: 'inserts',
                                  width: 90,
                                  render: (_: any, r: any) => {
                                      const ops = tableOptions[r.table] || { insert: true, update: true, delete: false };
                                      const disabled = !r.canSync || analyzing || Number(r.inserts || 0) === 0;
                                      return (
                                          <Checkbox
                                              checked={!!ops.insert}
                                              disabled={disabled}
                                              onChange={(e) => updateTableOption(r.table, 'insert', e.target.checked)}
                                          >
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
                                          <Checkbox
                                              checked={!!ops.update}
                                              disabled={disabled}
                                              onChange={(e) => updateTableOption(r.table, 'update', e.target.checked)}
                                          >
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
                                          <Checkbox
                                              checked={!!ops.delete}
                                              disabled={disabled}
                                              onChange={(e) => updateTableOption(r.table, 'delete', e.target.checked)}
                                          >
                                              {Number(r.deletes || 0)}
                                          </Checkbox>
                                      );
                                  }
                              },
                              { title: '相同', dataIndex: 'same', key: 'same', width: 70, render: (v: any) => Number(v || 0) },
                              { title: '消息', dataIndex: 'message', key: 'message', ellipsis: true, render: (v: any) => (v ? String(v) : '') },
                              {
                                  title: '预览',
                                  key: 'preview',
                                  width: 80,
                                  render: (_: any, r: any) => {
                                      const can = !!r.canSync;
                                      const hasDiff = Number(r.inserts || 0) + Number(r.updates || 0) + Number(r.deletes || 0) > 0;
                                      return (
                                          <Button size="small" disabled={!can || !hasDiff || analyzing} onClick={() => openPreview(r.table)}>
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
          <div>
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

              <div style={{ marginTop: 12 }}>
                  <Progress
                      percent={syncProgress.percent}
                      status={syncing ? "active" : (syncResult?.success ? "success" : "exception")}
                      format={() => `${syncProgress.current}/${syncProgress.total}`}
                  />
              </div>

              <Divider orientation="left">日志</Divider>
              <div
                  ref={logBoxRef}
                  onScroll={() => {
                      const el = logBoxRef.current;
                      if (!el) return;
                      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                      autoScrollRef.current = nearBottom;
                  }}
                  style={{ background: '#f5f5f5', padding: 12, height: 300, overflowY: 'auto', fontFamily: 'monospace' }}
              >
                  {syncLogs.map((item, i: number) => <div key={i}>{renderSyncLogItem(item)}</div>)}
              </div>
          </div>
      )}

      <div style={{ marginTop: 24, textAlign: 'right' }}>
          {currentStep === 0 && (
              <Button type="primary" onClick={nextToTables} loading={loading}>下一步</Button>
          )}
	          {currentStep === 1 && (
	              <>
	                <Button onClick={() => setCurrentStep(0)} style={{ marginRight: 8 }}>上一步</Button>
	                <Button onClick={analyzeDiff} loading={loading} disabled={syncContent === 'schema' || selectedTables.length === 0 || analyzing} style={{ marginRight: 8 }}>
	                    对比差异
	                </Button>
	                <Button
	                    type="primary"
	                    onClick={runSync}
                    loading={loading}
                    disabled={selectedTables.length === 0 || (syncContent !== 'schema' && diffTables.length === 0)}
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
    </Modal>
    <Drawer
        title={`差异预览：${previewTable}`}
        open={previewOpen}
        onClose={() => { setPreviewOpen(false); setPreviewTable(''); setPreviewData(null); }}
        width={900}
    >
        {previewLoading && <Alert type="info" showIcon message="正在加载差异预览..." />}
        {!previewLoading && previewData && (
            <div>
                <Alert
                    type="info"
                    showIcon
                    message={`插入 ${previewData.totalInserts || 0}，更新 ${previewData.totalUpdates || 0}，删除 ${previewData.totalDeletes || 0}（预览最多展示 200 条/类型）`}
                />
                <Divider />
                <Tabs
                    items={[
                        {
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
