import React, { useState } from 'react';
import { Modal, Form, Input, InputNumber, Button, message, Checkbox, Divider, Collapse, Select } from 'antd';
import { useStore } from '../store';
import { MySQLConnect } from '../../wailsjs/go/main/App';

const ConnectionModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [useSSH, setUseSSH] = useState(false);
  const [dbType, setDbType] = useState('mysql');
  const addConnection = useStore((state) => state.addConnection);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      
      const sshConfig = values.useSSH ? {
          host: values.sshHost,
          port: Number(values.sshPort),
          user: values.sshUser,
          password: values.sshPassword || "",
          keyPath: values.sshKeyPath || ""
      } : { host: "", port: 22, user: "", password: "", keyPath: "" };

      const config = { 
          type: values.type,
          host: values.host,
          port: Number(values.port || 0),
          user: values.user || "",
          password: values.password || "",
          database: values.database || "",
          useSSH: !!values.useSSH,
          ssh: sshConfig
      };
      
      const res = await MySQLConnect(config as any);
      setLoading(false);
      
      if (res.success) {
        addConnection({
          id: Date.now().toString(),
          name: values.name || (values.type === 'sqlite' ? 'SQLite DB' : values.host),
          config: config
        });
        message.success('连接已保存！');
        form.resetFields();
        setUseSSH(false);
        setDbType('mysql');
        onClose();
      } else {
        message.error('连接失败: ' + res.message);
      }
    } catch (e) {
      setLoading(false);
    }
  };

  const isSqlite = dbType === 'sqlite';

  return (
    <Modal 
        title="新建连接" 
        open={open} 
        onCancel={onClose} 
        onOk={handleOk} 
        confirmLoading={loading} 
        okText="确定" 
        cancelText="取消" 
        width={600}
        zIndex={10001} // Increase z-index
        destroyOnClose // Reset on close
        maskClosable={false} // Prevent accidental close by clicking mask, user must click X or Cancel
    >
      <Form 
        form={form} 
        layout="vertical" 
        initialValues={{ type: 'mysql', host: 'localhost', port: 3306, user: 'root', useSSH: false, sshPort: 22 }}
        onValuesChange={(changed) => {
            if (changed.useSSH !== undefined) setUseSSH(changed.useSSH);
            if (changed.type !== undefined) setDbType(changed.type);
        }}
      >
        <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="type" label="数据库类型" style={{ width: 120 }}>
                <Select>
                    <Select.Option value="mysql">MySQL</Select.Option>
                    <Select.Option value="postgres">PostgreSQL</Select.Option>
                    <Select.Option value="sqlite">SQLite</Select.Option>
                </Select>
            </Form.Item>
            <Form.Item name="name" label="连接名称" style={{ flex: 1 }}>
              <Input placeholder="例如：本地测试库" />
            </Form.Item>
        </div>
        
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
        <Form.Item name="database" label="默认数据库 (可选)">
            <Input />
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
      </Form>
    </Modal>
  );
};

export default ConnectionModal;