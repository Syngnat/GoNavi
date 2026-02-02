import React, { useState, useEffect } from 'react';
import { Modal, Form, Input, InputNumber, Button, message, Checkbox, Divider, Select, Alert, Card, Row, Col, Typography } from 'antd';
import { DatabaseOutlined, ConsoleSqlOutlined, FileTextOutlined, CloudServerOutlined, AppstoreAddOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { MySQLConnect, MySQLGetDatabases } from '../../wailsjs/go/app/App';
import { SavedConnection } from '../types';

const { Meta } = Card;
const { Text } = Typography;

const ConnectionModal: React.FC<{ open: boolean; onClose: () => void; initialValues?: SavedConnection | null }> = ({ open, onClose, initialValues }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [useSSH, setUseSSH] = useState(false);
  const [dbType, setDbType] = useState('mysql');
  const [step, setStep] = useState(1); // 1: Select Type, 2: Configure
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [dbList, setDbList] = useState<string[]>([]);
  const addConnection = useStore((state) => state.addConnection);
  const updateConnection = useStore((state) => state.updateConnection);

  useEffect(() => {
      if (open) {
          setTestResult(null); // Reset test result
          setDbList([]);
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
                  useSSH: initialValues.config.useSSH,
                  sshHost: initialValues.config.ssh?.host,
                  sshPort: initialValues.config.ssh?.port,
                  sshUser: initialValues.config.ssh?.user,
                  sshPassword: initialValues.config.ssh?.password,
                  sshKeyPath: initialValues.config.ssh?.keyPath,
                  driver: (initialValues.config as any).driver,
                  dsn: (initialValues.config as any).dsn
              });
              setUseSSH(initialValues.config.useSSH || false);
              setDbType(initialValues.config.type);
          } else {
              // Create mode: Start at step 1
              setStep(1);
              form.resetFields();
              setUseSSH(false);
              setDbType('mysql');
          }
      }
  }, [open, initialValues]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      
      const config = await buildConfig(values);
      
      const res = await MySQLConnect(config as any);
      setLoading(false);
      
      if (res.success) {
        const newConn = {
          id: initialValues ? initialValues.id : Date.now().toString(),
          name: values.name || (values.type === 'sqlite' ? 'SQLite DB' : values.host),
          config: config,
          includeDatabases: values.includeDatabases
        };

        if (initialValues) {
            updateConnection(newConn);
            message.success('连接已更新！');
        } else {
            addConnection(newConn);
            message.success('连接已保存！');
        }
        
        form.resetFields();
        setUseSSH(false);
        setDbType('mysql');
        setStep(1);
        onClose();
      } else {
        message.error('连接失败: ' + res.message);
      }
    } catch (e) {
      setLoading(false);
    }
  };

  const handleTest = async () => {
      try {
          const values = await form.validateFields();
          setLoading(true);
          setTestResult(null);
          const config = await buildConfig(values);
          const res = await (window as any).go.app.App.TestConnection(config);
          setLoading(false);
          if (res.success) {
              setTestResult({ type: 'success', message: res.message });
              const dbRes = await MySQLGetDatabases(config as any);
              if (dbRes.success) {
                  const dbs = (dbRes.data as any[]).map((row: any) => row.Database || row.database);
                  setDbList(dbs);
              }
          } else {
              setTestResult({ type: 'error', message: "测试失败: " + res.message });
          }
      } catch (e) {
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
          dsn: values.dsn
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
          case 'oracle': defaultPort = 1521; break;
          case 'dameng': defaultPort = 5236; break;
          case 'kingbase': defaultPort = 54321; break;
          default: defaultPort = 3306;
      }
      if (type !== 'sqlite' && type !== 'custom') {
          form.setFieldsValue({ port: defaultPort });
      }

      setStep(2);
  };

  const isSqlite = dbType === 'sqlite';
  const isCustom = dbType === 'custom';

  const dbTypes = [
      { key: 'mysql', name: 'MySQL', icon: <ConsoleSqlOutlined style={{ fontSize: 24, color: '#00758F' }} /> },
      { key: 'postgres', name: 'PostgreSQL', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#336791' }} /> },
      { key: 'sqlite', name: 'SQLite', icon: <FileTextOutlined style={{ fontSize: 24, color: '#003B57' }} /> },
      { key: 'oracle', name: 'Oracle', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#F80000' }} /> },
      { key: 'dameng', name: 'Dameng (达梦)', icon: <CloudServerOutlined style={{ fontSize: 24, color: '#1890ff' }} /> },
      { key: 'kingbase', name: 'Kingbase (人大金仓)', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#faad14' }} /> },
      { key: 'custom', name: 'Custom (自定义)', icon: <AppstoreAddOutlined style={{ fontSize: 24, color: '#595959' }} /> },
  ];

  const renderStep1 = () => (
      <Row gutter={[16, 16]}>
          {dbTypes.map(item => (
              <Col span={8} key={item.key}>
                  <Card 
                      hoverable 
                      onClick={() => handleTypeSelect(item.key)}
                      style={{ textAlign: 'center', cursor: 'pointer' }}
                  >
                      <div style={{ marginBottom: 12 }}>{item.icon}</div>
                      <Text strong>{item.name}</Text>
                  </Card>
              </Col>
          ))}
      </Row>
  );

  const renderStep2 = () => (
      <Form 
        form={form} 
        layout="vertical" 
        initialValues={{ type: 'mysql', host: 'localhost', port: 3306, user: 'root', useSSH: false, sshPort: 22 }}
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
              <Input placeholder={isSqlite ? "/path/to/db.sqlite" : "localhost"} />
            </Form.Item>
            {!isSqlite && (
            <Form.Item name="port" label="端口 (Port)" rules={[{ required: true, message: '请输入端口号' }]} style={{ width: 100 }}>
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            )}
        </div>

        {!isSqlite && (
        <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="user" label="用户名" rules={[{ required: true, message: '请输入用户名' }]} style={{ flex: 1 }}>
              <Input />
            </Form.Item>
            <Form.Item name="password" label="密码" style={{ flex: 1 }}>
              <Input.Password />
            </Form.Item>
        </div>
        )}
        
        {!isSqlite && (
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
                        <Form.Item name="sshHost" label="SSH 主机" rules={[{ required: useSSH, message: '请输入SSH主机' }]} style={{ flex: 1 }}>
                            <Input placeholder="ssh.example.com" />
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
          <Button key="test" loading={loading} onClick={handleTest}>测试连接</Button>,
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
        width={step === 1 ? 700 : 600}
        zIndex={10001} 
        destroyOnHidden 
        maskClosable={false}
    >
      {step === 1 ? renderStep1() : renderStep2()}
    </Modal>
  );
};

export default ConnectionModal;