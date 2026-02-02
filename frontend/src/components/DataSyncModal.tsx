import React, { useState, useEffect } from 'react';
import { Modal, Form, Select, Button, message, Steps, Transfer, Card, Alert, Divider, Typography } from 'antd';
import { useStore } from '../store';
import { DBGetDatabases, DBGetTables, DataSync } from '../../wailsjs/go/app/App';
import { SavedConnection } from '../types';
import { connection } from '../../wailsjs/go/models';

const { Title, Text } = Typography;
const { Step } = Steps;
const { Option } = Select;

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

  // Step 3: Result
  const [syncResult, setSyncResult] = useState<any>(null);

  useEffect(() => {
    if (open) {
        setCurrentStep(0);
        setSourceConnId('');
        setTargetConnId('');
        setSourceDb('');
        setTargetDb('');
        setSelectedTables([]);
        setSyncResult(null);
    }
  }, [open]);

  const handleSourceConnChange = async (connId: string) => {
      setSourceConnId(connId);
      setSourceDb('');
      const conn = connections.find(c => c.id === connId);
      if (conn) {
          setLoading(true);
          try {
            const res = await DBGetDatabases(conn.config as any);
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
            const res = await DBGetDatabases(conn.config as any);
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
              const config = { ...conn.config, database: sourceDb };
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

  const runSync = async () => {
      setLoading(true);
      const sConn = connections.find(c => c.id === sourceConnId)!;
      const tConn = connections.find(c => c.id === targetConnId)!;
      
      const config = {
          sourceConfig: { ...sConn.config, database: sourceDb },
          targetConfig: { ...tConn.config, database: targetDb },
          tables: selectedTables,
          mode: "insert_update"
      };

      try {
          const res = await DataSync(config as any);
          setSyncResult(res);
          setCurrentStep(2);
      } catch (e) {
          message.error("Sync execution failed");
      }
      setLoading(false);
  };

  return (
    <Modal
      title="数据同步"
      open={open}
      onCancel={onClose}
      width={800}
      footer={null}
      destroyOnHidden
    >
      <Steps current={currentStep} style={{ marginBottom: 24 }}>
        <Step title="配置源与目标" />
        <Step title="选择表" />
        <Step title="执行结果" />
      </Steps>

      {/* STEP 1: CONFIG */}
      {currentStep === 0 && (
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
      )}

      {/* STEP 2: TABLES */}
      {currentStep === 1 && (
          <div style={{ height: 400 }}>
              <Text type="secondary">请选择需要同步的表:</Text>
              <Transfer
                dataSource={allTables.map(t => ({ key: t, title: t }))}
                titles={['源表', '已选表']}
                targetKeys={selectedTables}
                onChange={(keys) => setSelectedTables(keys as string[])}
                render={item => item.title}
                listStyle={{ width: 350, height: 350, marginTop: 12 }}
                locale={{ itemUnit: '项', itemsUnit: '项', searchPlaceholder: '搜索表', notFoundContent: '暂无数据' }}
              />
          </div>
      )}

      {/* STEP 3: RESULT */}
      {currentStep === 2 && syncResult && (
          <div>
              <Alert 
                message={syncResult.success ? "同步完成" : "同步失败"}
                description={syncResult.message || `成功同步 ${syncResult.tablesSynced} 张表. 插入: ${syncResult.rowsInserted}, 更新: ${syncResult.rowsUpdated}`}
                type={syncResult.success ? "success" : "error"}
                showIcon
              />
              <Divider orientation="left">日志</Divider>
              <div style={{ background: '#f5f5f5', padding: 12, height: 300, overflowY: 'auto', fontFamily: 'monospace' }}>
                  {syncResult.logs.map((log: string, i: number) => <div key={i}>{log}</div>)}
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
                <Button type="primary" onClick={runSync} loading={loading} disabled={selectedTables.length === 0}>开始同步</Button>
              </>
          )}
          {currentStep === 2 && (
              <>
                  <Button onClick={() => setCurrentStep(1)} style={{ marginRight: 8 }}>继续同步</Button>
                  <Button type="primary" onClick={onClose}>关闭</Button>
              </>
          )}
      </div>
    </Modal>
  );
};

export default DataSyncModal;
