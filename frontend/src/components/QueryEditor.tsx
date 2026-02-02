import React, { useState, useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { Button, Table, message, Modal, Input, Form, Dropdown, MenuProps, Tooltip } from 'antd';
import { PlayCircleOutlined, SaveOutlined, FormatPainterOutlined, SettingOutlined } from '@ant-design/icons';
import { format } from 'sql-formatter';
import { TabData } from '../types';
import { useStore } from '../store';
import { MySQLQuery, DBGetTables, DBGetAllColumns } from '../../wailsjs/go/main/App';

const QueryEditor: React.FC<{ tab: TabData }> = ({ tab }) => {
  const [query, setQuery] = useState(tab.query || 'SELECT * FROM ');
  const [results, setResults] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveForm] = Form.useForm();
  
  // Resizing state
  const [editorHeight, setEditorHeight] = useState(300);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const dragRef = useRef<{ startY: number, startHeight: number } | null>(null);
  const tablesRef = useRef<string[]>([]); // Store tables for autocomplete
  const allColumnsRef = useRef<{tableName: string, name: string, type: string}[]>([]); // Store all columns

  const connections = useStore(state => state.connections);
  const saveQuery = useStore(state => state.saveQuery);
  const darkMode = useStore(state => state.darkMode);
  const sqlFormatOptions = useStore(state => state.sqlFormatOptions);
  const setSqlFormatOptions = useStore(state => state.setSqlFormatOptions);

  // If opening a saved query, load its SQL
  useEffect(() => {
      if (tab.query) {
          setQuery(tab.query);
      }
  }, [tab.query]);

  // Fetch Metadata for Autocomplete
  useEffect(() => {
      const fetchMetadata = async () => {
          const conn = connections.find(c => c.id === tab.connectionId);
          if (!conn) return;

          const config = { 
            ...conn.config, 
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
          };

          const dbName = tab.dbName || conn.config.database || "";

          // Fetch Tables
          const resTables = await DBGetTables(config as any, dbName);
          if (resTables.success && Array.isArray(resTables.data)) {
              // res.data is [{Table: "name"}, ...]
              const tableNames = resTables.data.map((row: any) => Object.values(row)[0] as string);
              tablesRef.current = tableNames;
          }

          // Fetch All Columns (Optimized for autocomplete)
          if (config.type === 'mysql' || !config.type) {
              const resCols = await DBGetAllColumns(config as any, dbName);
              if (resCols.success && Array.isArray(resCols.data)) {
                  allColumnsRef.current = resCols.data;
              }
          }
      };
      fetchMetadata();
  }, [tab.connectionId, tab.dbName, connections]);

  // Handle Resizing
  const handleMouseDown = (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startHeight: editorHeight };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientY - dragRef.current.startY;
      const newHeight = Math.max(100, Math.min(window.innerHeight - 200, dragRef.current.startHeight + delta));
      setEditorHeight(newHeight);
  };

  const handleMouseUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
  };

  // Setup Autocomplete and Editor
  const handleEditorDidMount: OnMount = (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // SQL Autocomplete
      monaco.languages.registerCompletionItemProvider('sql', {
          provideCompletionItems: (model: any, position: any) => {
              const word = model.getWordUntilPosition(position);
              const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endColumn: word.endColumn,
              };

              // Simple Heuristic: Find tables mentioned in the query
              const tableRegex = /(?:FROM|JOIN|UPDATE|INTO)\s+[`"]?(\w+)[`"]?/gi;
              const foundTables = new Set<string>();
              let match;
              const fullText = model.getValue(); 
              while ((match = tableRegex.exec(fullText)) !== null) {
                  foundTables.add(match[1]);
              }

              // Columns suggestion
              const relevantColumns = allColumnsRef.current
                  .filter(c => foundTables.has(c.tableName))
                  .map(c => ({
                      label: c.name,
                      kind: monaco.languages.CompletionItemKind.Field,
                      insertText: c.name,
                      detail: `${c.type} (${c.tableName})`,
                      range,
                      sortText: '0' + c.name
                  }));

              const suggestions = [
                  // Keywords
                  ...['SELECT', 'FROM', 'WHERE', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP BY', 'ORDER BY', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'VALUES', 'SET', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'Add', 'MODIFY', 'CHANGE', 'COLUMN', 'KEY', 'PRIMARY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'AUTO_INCREMENT', 'COMMENT', 'SHOW', 'DESCRIBE', 'EXPLAIN'].map(k => ({
                      label: k,
                      kind: monaco.languages.CompletionItemKind.Keyword,
                      insertText: k,
                      range
                  })),
                  // Tables
                  ...tablesRef.current.map(t => ({
                      label: t,
                      kind: monaco.languages.CompletionItemKind.Class,
                      insertText: t,
                      detail: 'Table',
                      range
                  })),
                  // Columns
                  ...relevantColumns
              ];
              return { suggestions };
          }
      });
  };

  const handleFormat = () => {
      try {
          const formatted = format(query, { language: 'mysql', keywordCase: sqlFormatOptions.keywordCase });
          setQuery(formatted);
      } catch (e) {
          message.error("格式化失败: SQL 语法可能有误");
      }
  };

  const formatSettingsMenu: MenuProps['items'] = [
      { 
          key: 'upper', 
          label: '关键字大写', 
          icon: sqlFormatOptions.keywordCase === 'upper' ? '✓' : undefined,
          onClick: () => setSqlFormatOptions({ keywordCase: 'upper' }) 
      },
      { 
          key: 'lower', 
          label: '关键字小写', 
          icon: sqlFormatOptions.keywordCase === 'lower' ? '✓' : undefined,
          onClick: () => setSqlFormatOptions({ keywordCase: 'lower' }) 
      },
  ];

  const handleRun = async () => {
    if (!query.trim()) return;
    setLoading(true);
    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
        message.error("Connection not found");
        setLoading(false);
        return;
    }

    const config = { 
        ...conn.config, 
        port: Number(conn.config.port),
        password: conn.config.password || "",
        database: conn.config.database || "",
        useSSH: conn.config.useSSH || false,
        ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
    };
    const res = await MySQLQuery(config as any, tab.dbName || conn.config.database || '', query);

    if (res.success) {
      if (Array.isArray(res.data)) {
        if (res.data.length > 0) {
            const cols = Object.keys(res.data[0]).map(key => ({
              title: key,
              dataIndex: key,
              key: key,
              ellipsis: true,
              render: (text: any) => typeof text === 'object' ? JSON.stringify(text) : String(text),
            }));
            setColumns(cols);
            setResults(res.data.map((row: any, i: number) => ({ ...row, key: i })));
        } else {
            message.info('查询执行成功，但没有返回结果。');
            setResults([]);
            setColumns([]);
        }
      } else {
          // Handle update/insert results
          const affected = (res.data as any).affectedRows;
          message.success(`受影响行数: ${affected}`);
          setResults([]);
      }
    } else {
      message.error(res.message);
    }
    setLoading(false);
  };

  const handleSave = async () => {
      try {
          const values = await saveForm.validateFields();
          saveQuery({
              id: tab.id.startsWith('saved-') ? tab.id : `saved-${Date.now()}`,
              name: values.name,
              sql: query,
              connectionId: tab.connectionId,
              dbName: tab.dbName || '',
              createdAt: Date.now()
          });
          message.success('查询已保存！');
          setIsSaveModalOpen(false);
      } catch (e) {
          // validation failed
      }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '8px', borderBottom: '1px solid #eee', display: 'flex', gap: '8px', flexShrink: 0 }}>
        <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={loading}>
          运行
        </Button>
        <Button icon={<SaveOutlined />} onClick={() => {
            saveForm.setFieldsValue({ name: tab.title.replace('Query (', '').replace(')', '') });
            setIsSaveModalOpen(true);
        }}>
          保存
        </Button>
        
        <Button.Group>
            <Tooltip title="美化 SQL">
                <Button icon={<FormatPainterOutlined />} onClick={handleFormat}>美化</Button>
            </Tooltip>
            <Dropdown menu={{ items: formatSettingsMenu }} placement="bottomRight">
                <Button icon={<SettingOutlined />} />
            </Dropdown>
        </Button.Group>
      </div>
      
      {/* Editor Area - Resizable */}
      <div style={{ height: editorHeight, minHeight: '100px', borderBottom: '1px solid #eee' }}>
        <Editor 
          height="100%" 
          defaultLanguage="sql" 
          theme={darkMode ? "vs-dark" : "light"}
          value={query} 
          onChange={(val) => setQuery(val || '')}
          onMount={handleEditorDidMount}
          options={{ 
            minimap: { enabled: false }, 
            automaticLayout: true,
            scrollBeyondLastLine: false,
            fontSize: 14
          }}
        />
      </div>

      {/* Resize Handle */}
      <div 
        onMouseDown={handleMouseDown}
        style={{ 
            height: '5px', 
            cursor: 'row-resize', 
            background: darkMode ? '#333' : '#f0f0f0',
            flexShrink: 0,
            zIndex: 10 
        }} 
        title="拖动调整高度"
      />

      {/* Results Area - Fills remaining space */}
      <div style={{ flex: 1, overflow: 'hidden', padding: 10, display: 'flex', flexDirection: 'column' }}>
         <Table 
            dataSource={results} 
            columns={columns} 
            size="small" 
            scroll={{ x: 'max-content', y: 'calc(100% - 40px)' }} 
            loading={loading}
            pagination={false}
            style={{ flex: 1, overflow: 'hidden' }}
         />
      </div>

      <Modal 
        title="保存查询" 
        open={isSaveModalOpen} 
        onOk={handleSave} 
        onCancel={() => setIsSaveModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
          <Form form={saveForm} layout="vertical">
              <Form.Item name="name" label="查询名称" rules={[{ required: true, message: '请输入查询名称' }]}>
                  <Input placeholder="例如：查询所有用户" />
              </Form.Item>
          </Form>
      </Modal>
    </div>
  );
};

export default QueryEditor;
