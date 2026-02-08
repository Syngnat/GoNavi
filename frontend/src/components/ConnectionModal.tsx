import React, { useState, useEffect, useRef } from 'react';
import { Modal, Form, Input, InputNumber, Button, message, Checkbox, Divider, Select, Alert, Card, Row, Col, Typography, Collapse } from 'antd';
import { DatabaseOutlined, ConsoleSqlOutlined, FileTextOutlined, CloudServerOutlined, AppstoreAddOutlined, CloudOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { DBGetDatabases, TestConnection, RedisConnect } from '../../wailsjs/go/app/App';
import { SavedConnection } from '../types';

const { Meta } = Card;
const { Text } = Typography;

const ConnectionModal: React.FC<{ open: boolean; onClose: () => void; initialValues?: SavedConnection | null }> = ({ open, onClose, initialValues }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [useSSH, setUseSSH] = useState(false);
  const [dbType, setDbType] = useState('mysql');
  const [step, setStep] = useState(1); // 1: Select Type, 2: Configure
  const [activeGroup, setActiveGroup] = useState(0); // Active category index in step 1
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [dbList, setDbList] = useState<string[]>([]);
  const [redisDbList, setRedisDbList] = useState<number[]>([]); // Redis databases 0-15
  const testInFlightRef = useRef(false);
  const testTimerRef = useRef<number | null>(null);
  const addConnection = useStore((state) => state.addConnection);
  const updateConnection = useStore((state) => state.updateConnection);

  useEffect(() => {
      if (open) {
          setTestResult(null); // Reset test result
          setDbList([]);
          setRedisDbList([]);
          if (initialValues) {
              // Edit mode: Go directly to step 2
              setStep(2);
              form.setFieldsValue({
                  type: initialValues.config.type,
                  name: initialValues.name,
                  host: initialValues.config.host,
                  port: initialValues.config.port,
                  user: initialValues.config.user,
                  password: initialValues.config.password,
                  database: initialValues.config.database,
                  includeDatabases: initialValues.includeDatabases,
                  includeRedisDatabases: initialValues.includeRedisDatabases,
                  useSSH: initialValues.config.useSSH,
                  sshHost: initialValues.config.ssh?.host,
                  sshPort: initialValues.config.ssh?.port,
                  sshUser: initialValues.config.ssh?.user,
                  sshPassword: initialValues.config.ssh?.password,
                  sshKeyPath: initialValues.config.ssh?.keyPath,
                  driver: (initialValues.config as any).driver,
                  dsn: (initialValues.config as any).dsn,
                  timeout: (initialValues.config as any).timeout || 30
              });
              setUseSSH(initialValues.config.useSSH || false);
              setDbType(initialValues.config.type);
              // 如果是 Redis 编辑模式，设置已保存的 Redis 数据库列表
              if (initialValues.config.type === 'redis') {
                  setRedisDbList(Array.from({ length: 16 }, (_, i) => i));
              }
          } else {
              // Create mode: Start at step 1
              setStep(1);
              form.resetFields();
              setUseSSH(false);
              setDbType('mysql');
              setActiveGroup(0);
          }
      }
  }, [open, initialValues]);

  useEffect(() => {
      return () => {
          if (testTimerRef.current !== null) {
              window.clearTimeout(testTimerRef.current);
              testTimerRef.current = null;
          }
      };
  }, []);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      const config = await buildConfig(values);

      const isRedisType = values.type === 'redis';
      const newConn = {
        id: initialValues ? initialValues.id : Date.now().toString(),
        name: values.name || (values.type === 'sqlite' ? 'SQLite DB' : (values.type === 'redis' ? `Redis ${values.host}` : values.host)),
        config: config,
        includeDatabases: values.includeDatabases,
        includeRedisDatabases: isRedisType ? values.includeRedisDatabases : undefined
      };

      if (initialValues) {
          updateConnection(newConn);
          message.success('配置已更新（未连接）');
      } else {
          addConnection(newConn);
          message.success('配置已保存（未连接）');
      }

      setLoading(false);
      form.resetFields();
      setUseSSH(false);
      setDbType('mysql');
      setStep(1);
      onClose();
    } catch (e) {
      setLoading(false);
    }
  };

  const requestTest = () => {
      if (loading) return;
      if (testTimerRef.current !== null) return;
      testTimerRef.current = window.setTimeout(() => {
          testTimerRef.current = null;
          handleTest();
      }, 0);
  };

  const handleTest = async () => {
      if (testInFlightRef.current) return;
      testInFlightRef.current = true;
      try {
          const values = await form.validateFields();
          setLoading(true);
          setTestResult(null);
          const config = await buildConfig(values);

          // Use different API for Redis
          const isRedisType = values.type === 'redis';
          const res = isRedisType
              ? await RedisConnect(config as any)
              : await TestConnection(config as any);

          if (res.success) {
              setTestResult({ type: 'success', message: res.message });
              if (isRedisType) {
                  // Redis: generate database list 0-15
                  setRedisDbList(Array.from({ length: 16 }, (_, i) => i));
              } else {
                  // Other databases: fetch database list
                  const dbRes = await DBGetDatabases(config as any);
                  if (dbRes.success) {
                      const dbs = (dbRes.data as any[]).map((row: any) => row.Database || row.database);
                      setDbList(dbs);
                  }
              }
          } else {
              setTestResult({ type: 'error', message: "测试失败: " + res.message });
          }
      } catch (e) {
          // ignore
      } finally {
          testInFlightRef.current = false;
          setLoading(false);
      }
  };

  const buildConfig = async (values: any) => {
      const sshConfig = values.useSSH ? {
          host: values.sshHost,
          port: Number(values.sshPort),
          user: values.sshUser,
          password: values.sshPassword || "",
          keyPath: values.sshKeyPath || ""
      } : { host: "", port: 22, user: "", password: "", keyPath: "" };

      return {
          type: values.type,
          host: values.host || "",
          port: Number(values.port || 0),
          user: values.user || "",
          password: values.password || "",
          database: values.database || "",
          useSSH: !!values.useSSH,
          ssh: sshConfig,
          driver: values.driver,
          dsn: values.dsn,
          timeout: Number(values.timeout || 30)
      };
  };

  const handleTypeSelect = (type: string) => {
      setDbType(type);
      form.setFieldsValue({ type: type });

      // Auto-fill default port
      let defaultPort = 3306;
      switch (type) {
          case 'mysql': defaultPort = 3306; break;
          case 'postgres': defaultPort = 5432; break;
          case 'redis': defaultPort = 6379; break;
          case 'oracle': defaultPort = 1521; break;
          case 'dameng': defaultPort = 5236; break;
          case 'kingbase': defaultPort = 54321; break;
          case 'sqlserver': defaultPort = 1433; break;
          case 'mongodb': defaultPort = 27017; break;
          case 'highgo': defaultPort = 5866; break;
          case 'mariadb': defaultPort = 3306; break;
          case 'vastbase': defaultPort = 5432; break;
          default: defaultPort = 3306;
      }
      if (type !== 'sqlite' && type !== 'custom') {
          form.setFieldsValue({ port: defaultPort });
      }

      setStep(2);
  };

  const isSqlite = dbType === 'sqlite';
  const isCustom = dbType === 'custom';
  const isRedis = dbType === 'redis';

  const dbTypeGroups = [
      { label: '关系型数据库', items: [
          { key: 'mysql', name: 'MySQL', icon: <ConsoleSqlOutlined style={{ fontSize: 24, color: '#00758F' }} /> },
          { key: 'mariadb', name: 'MariaDB', icon: <ConsoleSqlOutlined style={{ fontSize: 24, color: '#003545' }} /> },
          { key: 'postgres', name: 'PostgreSQL', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#336791' }} /> },
          { key: 'sqlserver', name: 'SQL Server', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#CC2927' }} /> },
          { key: 'sqlite', name: 'SQLite', icon: <FileTextOutlined style={{ fontSize: 24, color: '#003B57' }} /> },
          { key: 'oracle', name: 'Oracle', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#F80000' }} /> },
      ]},
      { label: '国产数据库', items: [
          { key: 'dameng', name: 'Dameng (达梦)', icon: <CloudServerOutlined style={{ fontSize: 24, color: '#1890ff' }} /> },
          { key: 'kingbase', name: 'Kingbase (人大金仓)', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#faad14' }} /> },
          { key: 'highgo', name: 'HighGo (瀚高)', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#00a854' }} /> },
          { key: 'vastbase', name: 'Vastbase (海量)', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#1a6dff' }} /> },
      ]},
      { label: 'NoSQL', items: [
          { key: 'mongodb', name: 'MongoDB', icon: <CloudServerOutlined style={{ fontSize: 24, color: '#47A248' }} /> },
          { key: 'redis', name: 'Redis', icon: <CloudOutlined style={{ fontSize: 24, color: '#DC382D' }} /> },
      ]},
      { label: '其他', items: [
          { key: 'custom', name: 'Custom (自定义)', icon: <AppstoreAddOutlined style={{ fontSize: 24, color: '#595959' }} /> },
      ]},
  ];

  const dbTypes = dbTypeGroups.flatMap(g => g.items);

  const renderStep1 = () => (
      <div style={{ display: 'flex', height: 360 }}>
          {/* 左侧分类导航 */}
          <div style={{ width: 120, borderRight: '1px solid #f0f0f0', paddingRight: 8, flexShrink: 0 }}>
              {dbTypeGroups.map((group, idx) => (
                  <div
                      key={group.label}
                      onClick={() => setActiveGroup(idx)}
                      style={{
                          padding: '10px 12px',
                          cursor: 'pointer',
                          borderRadius: 6,
                          marginBottom: 4,
                          background: activeGroup === idx ? '#e6f4ff' : 'transparent',
                          color: activeGroup === idx ? '#1677ff' : undefined,
                          fontWeight: activeGroup === idx ? 500 : 400,
                          transition: 'all 0.2s',
                          fontSize: 13,
                      }}
                  >
                      {group.label}
                  </div>
              ))}
          </div>
          {/* 右侧数据源卡片 */}
          <div style={{ flex: 1, paddingLeft: 16, overflowY: 'auto', overflowX: 'hidden' }}>
              <Row gutter={[12, 12]}>
                  {dbTypeGroups[activeGroup]?.items.map(item => (
                      <Col span={8} key={item.key}>
                          <Card
                              hoverable
                              onClick={() => handleTypeSelect(item.key)}
                              style={{ textAlign: 'center', cursor: 'pointer', height: 100 }}
                              styles={{ body: { padding: '16px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' } }}
                          >
                              <div style={{ marginBottom: 8 }}>{item.icon}</div>
                              <Text strong style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{item.name}</Text>
                          </Card>
                      </Col>
                  ))}
              </Row>
          </div>
      </div>
  );

  const renderStep2 = () => (
      <Form 
        form={form} 
        layout="vertical" 
        initialValues={{ type: 'mysql', host: 'localhost', port: 3306, user: 'root', useSSH: false, sshPort: 22, timeout: 30 }}
        onValuesChange={(changed) => {
            if (testResult) setTestResult(null); // Clear result on change
            if (changed.useSSH !== undefined) setUseSSH(changed.useSSH);
            // Type change handled by step 1, but keep sync if select changes (hidden now)
            if (changed.type !== undefined) setDbType(changed.type);
        }}
      >
        {/* Hidden Type Field to keep form value synced */}
        <Form.Item name="type" hidden><Input /></Form.Item>

        <Form.Item name="name" label="连接名称">
            <Input placeholder="例如：本地测试库" />
        </Form.Item>
        
        {isCustom ? (
            <>
                <Form.Item name="driver" label="驱动名称 (Driver Name)" rules={[{ required: true, message: '请输入驱动名称' }]} help="已支持: mysql, postgres, sqlite, oracle, dm, kingbase">
                    <Input placeholder="例如: mysql, postgres" />
                </Form.Item>
                <Form.Item name="dsn" label="连接字符串 (DSN)" rules={[{ required: true, message: '请输入连接字符串' }]}>
                    <Input.TextArea rows={3} placeholder="例如: user:pass@tcp(localhost:3306)/dbname?charset=utf8" />
                </Form.Item>
            </>
        ) : (
        <>
        <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="host" label={isSqlite ? "文件路径 (绝对路径)" : "主机地址 (Host)"} rules={[{ required: true, message: '请输入地址/路径' }]} style={{ flex: 1 }}>
              <Input
                placeholder={isSqlite ? "/path/to/db.sqlite" : "localhost"}
                onDoubleClick={requestTest}
              />
            </Form.Item>
            {!isSqlite && (
            <Form.Item name="port" label="端口 (Port)" rules={[{ required: true, message: '请输入端口号' }]} style={{ width: 100 }}>
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            )}
        </div>

        {/* Redis specific: password only, no username */}
        {isRedis && (
        <>
            <Form.Item name="password" label="密码 (可选)">
              <Input.Password placeholder="Redis 密码（如果设置了 requirepass）" />
            </Form.Item>
            <Form.Item name="includeRedisDatabases" label="显示数据库 (留空显示全部)" help="连接测试成功后可选择">
                <Select mode="multiple" placeholder="选择显示的数据库 (0-15)" allowClear>
                    {redisDbList.map(db => <Select.Option key={db} value={db}>db{db}</Select.Option>)}
                </Select>
            </Form.Item>
        </>
        )}

        {/* Non-Redis, non-SQLite: username and password */}
        {!isSqlite && !isRedis && (
        <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="user" label="用户名" rules={[{ required: true, message: '请输入用户名' }]} style={{ flex: 1 }}>
              <Input />
            </Form.Item>
            <Form.Item name="password" label="密码" style={{ flex: 1 }}>
              <Input.Password />
            </Form.Item>
        </div>
        )}

        {!isSqlite && !isRedis && (
        <Form.Item name="includeDatabases" label="显示数据库 (留空显示全部)" help="连接测试成功后可选择">
            <Select mode="multiple" placeholder="选择显示的数据库" allowClear>
                {dbList.map(db => <Select.Option key={db} value={db}>{db}</Select.Option>)}
            </Select>
        </Form.Item>
        )}

        {!isSqlite && (
        <>
            <Divider style={{ margin: '12px 0' }} />
            <Form.Item name="useSSH" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Checkbox>使用 SSH 隧道 (SSH Tunnel)</Checkbox>
            </Form.Item>

            {useSSH && (
                <div style={{ padding: '12px', background: '#f5f5f5', borderRadius: 6, marginTop: 12 }}>
                    <div style={{ display: 'flex', gap: 16 }}>
                        <Form.Item name="sshHost" label="SSH 主机 (域名或IP)" rules={[{ required: useSSH, message: '请输入SSH主机' }]} style={{ flex: 1 }}>
                            <Input placeholder="例如: ssh.example.com 或 192.168.1.100" />
                        </Form.Item>
                        <Form.Item name="sshPort" label="端口" rules={[{ required: useSSH, message: '请输入SSH端口' }]} style={{ width: 100 }}>
                            <InputNumber style={{ width: '100%' }} />
                        </Form.Item>
                    </div>
                    <div style={{ display: 'flex', gap: 16 }}>
                        <Form.Item name="sshUser" label="SSH 用户" rules={[{ required: useSSH, message: '请输入SSH用户' }]} style={{ flex: 1 }}>
                            <Input placeholder="root" />
                        </Form.Item>
                        <Form.Item name="sshPassword" label="SSH 密码" style={{ flex: 1 }}>
                            <Input.Password placeholder="密码" />
                        </Form.Item>
                    </div>
                     <Form.Item name="sshKeyPath" label="私钥路径 (可选)" help="例如: /Users/name/.ssh/id_rsa">
                        <Input placeholder="绝对路径" />
                    </Form.Item>
                </div>
            )}

            <Divider style={{ margin: '12px 0' }} />
            
            <Collapse 
                ghost 
                items={[{
                    key: 'advanced',
                    label: '高级连接',
                    children: (
                        <Form.Item 
                            name="timeout" 
                            label="连接超时 (秒)" 
                            help="数据库连接超时时间，默认 30 秒"
                            rules={[{ type: 'number', min: 1, max: 300, message: '超时时间范围: 1-300 秒' }]}
                        >
                            <InputNumber style={{ width: '100%' }} min={1} max={300} placeholder="30" />
                        </Form.Item>
                    )
                }]}
            />
        </>
        )}
        </>
        )}
        
        {testResult && (
          <Alert
              message={testResult.message}
              type={testResult.type}
              showIcon
              style={{ marginTop: 16 }}
          />
        )}
      </Form>
  );

  const getFooter = () => {
      if (step === 1) {
          return [
             <Button key="cancel" onClick={onClose}>取消</Button>
          ];
      }
      return [
          !initialValues && <Button key="back" onClick={() => setStep(1)} style={{ float: 'left' }}>上一步</Button>,
          <Button key="test" loading={loading} onClick={requestTest}>测试连接</Button>,
          <Button key="cancel" onClick={onClose}>取消</Button>,
          <Button key="submit" type="primary" loading={loading} onClick={handleOk}>保存</Button>
      ];
  };

  const getTitle = () => {
      if (step === 1) return "选择数据源类型";
      const typeName = dbTypes.find(t => t.key === dbType)?.name || dbType;
      return initialValues ? "编辑连接" : `新建 ${typeName} 连接`;
  };

  return (
    <Modal
        title={getTitle()}
        open={open}
        onCancel={onClose}
        footer={getFooter()}
        width={step === 1 ? 650 : 600}
        zIndex={10001}
        destroyOnHidden
        maskClosable={false}
        styles={step === 1 ? { body: { padding: '16px 24px', overflow: 'hidden' } } : undefined}
    >
      {step === 1 ? renderStep1() : renderStep2()}
    </Modal>
  );
};

export default ConnectionModal;
