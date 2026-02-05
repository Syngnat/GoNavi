import React, { useState, useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { Button, message, Modal, Input, Form, Dropdown, MenuProps, Tooltip, Select, Tabs } from 'antd';
import { PlayCircleOutlined, SaveOutlined, FormatPainterOutlined, SettingOutlined, CloseOutlined } from '@ant-design/icons';
import { format } from 'sql-formatter';
import { TabData, ColumnDefinition } from '../types';
import { useStore } from '../store';
import { DBQuery, DBGetTables, DBGetAllColumns, DBGetDatabases, DBGetColumns } from '../../wailsjs/go/app/App';
import DataGrid, { GONAVI_ROW_KEY } from './DataGrid';

const QueryEditor: React.FC<{ tab: TabData }> = ({ tab }) => {
  const [query, setQuery] = useState(tab.query || 'SELECT * FROM ');
  
  type ResultSet = {
      key: string;
      sql: string;
      rows: any[];
      columns: string[];
      tableName?: string;
      pkColumns: string[];
      readOnly: boolean;
      truncated?: boolean;
      pkLoading?: boolean;
  };

  // Result Sets
  const [resultSets, setResultSets] = useState<ResultSet[]>([]);
  const [activeResultKey, setActiveResultKey] = useState<string>('');
  
  const [loading, setLoading] = useState(false);
  const runSeqRef = useRef(0);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveForm] = Form.useForm();
  
  // Database Selection
  const [currentConnectionId, setCurrentConnectionId] = useState<string>(tab.connectionId);
  const [currentDb, setCurrentDb] = useState<string>(tab.dbName || '');
  const [dbList, setDbList] = useState<string[]>([]);

  // Resizing state
  const [editorHeight, setEditorHeight] = useState(300);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const dragRef = useRef<{ startY: number, startHeight: number } | null>(null);
  const tablesRef = useRef<string[]>([]); // Store tables for autocomplete
  const allColumnsRef = useRef<{tableName: string, name: string, type: string}[]>([]); // Store all columns

  const connections = useStore(state => state.connections);
  const addSqlLog = useStore(state => state.addSqlLog);
  const currentConnectionIdRef = useRef(currentConnectionId);
  const currentDbRef = useRef(currentDb);
  const connectionsRef = useRef(connections);
  const columnsCacheRef = useRef<Record<string, ColumnDefinition[]>>({});
  const saveQuery = useStore(state => state.saveQuery);
  const darkMode = useStore(state => state.darkMode);
  const sqlFormatOptions = useStore(state => state.sqlFormatOptions);
  const setSqlFormatOptions = useStore(state => state.setSqlFormatOptions);
  const queryOptions = useStore(state => state.queryOptions);
  const setQueryOptions = useStore(state => state.setQueryOptions);

  useEffect(() => {
      currentConnectionIdRef.current = currentConnectionId;
  }, [currentConnectionId]);

  useEffect(() => {
      currentDbRef.current = currentDb;
  }, [currentDb]);

  useEffect(() => {
      connectionsRef.current = connections;
  }, [connections]);

  // If opening a saved query, load its SQL
  useEffect(() => {
      if (tab.query) setQuery(tab.query);
  }, [tab.query]);

  // Fetch Database List
  useEffect(() => {
      const fetchDbs = async () => {
          const conn = connections.find(c => c.id === currentConnectionId);
          if (!conn) return;
          
          const config = { 
            ...conn.config, 
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
          };

          const res = await DBGetDatabases(config as any);
          if (res.success && Array.isArray(res.data)) {
              const dbs = res.data.map((row: any) => row.Database || row.database);
              setDbList(dbs);
              if (!currentDbRef.current) {
                  if (conn.config.database) setCurrentDb(conn.config.database);
                  else if (dbs.length > 0 && dbs[0] !== 'information_schema') setCurrentDb(dbs[0]);
              }
          } else {
              setDbList([]);
          }
      };
      fetchDbs();
  }, [currentConnectionId, connections]);

  // Fetch Metadata for Autocomplete
  useEffect(() => {
      const fetchMetadata = async () => {
          const conn = connections.find(c => c.id === currentConnectionId);
          if (!conn || !currentDb) return;

          const config = { 
            ...conn.config, 
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
          };

          const resTables = await DBGetTables(config as any, currentDb);
          if (resTables.success && Array.isArray(resTables.data)) {
              const tableNames = resTables.data.map((row: any) => Object.values(row)[0] as string);
              tablesRef.current = tableNames;
          } else {
              tablesRef.current = [];
          }

          if (config.type === 'mysql' || !config.type) {
              const resCols = await DBGetAllColumns(config as any, currentDb);
              if (resCols.success && Array.isArray(resCols.data)) {
                  allColumnsRef.current = resCols.data;
              } else {
                  allColumnsRef.current = [];
              }
          }
      };
      fetchMetadata();
  }, [currentConnectionId, currentDb, connections]);

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

      monaco.languages.registerCompletionItemProvider('sql', {
          triggerCharacters: ['.'],
          provideCompletionItems: async (model: any, position: any) => {
              const word = model.getWordUntilPosition(position);
              const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endColumn: word.endColumn,
              };

              const stripQuotes = (ident: string) => {
                  let raw = (ident || '').trim();
                  if (!raw) return raw;
                  const first = raw[0];
                  const last = raw[raw.length - 1];
                  if ((first === '`' && last === '`') || (first === '"' && last === '"')) {
                      raw = raw.slice(1, -1);
                  }
                  return raw.trim();
              };

              const normalizeQualifiedName = (ident: string) => {
                  const raw = (ident || '').trim();
                  if (!raw) return raw;
                  return raw
                      .split('.')
                      .map(p => stripQuotes(p.trim()))
                      .filter(Boolean)
                      .join('.');
              };

              const getLastPart = (qualified: string) => {
                  const raw = normalizeQualifiedName(qualified);
                  if (!raw) return raw;
                  const parts = raw.split('.').filter(Boolean);
                  return parts[parts.length - 1] || raw;
              };

              const buildConnConfig = () => {
                  const connId = currentConnectionIdRef.current;
                  const conn = connectionsRef.current.find(c => c.id === connId);
                  if (!conn) return null;
                  return {
                      ...conn.config,
                      port: Number(conn.config.port),
                      password: conn.config.password || "",
                      database: conn.config.database || "",
                      useSSH: conn.config.useSSH || false,
                      ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
                  };
              };

              const getColumnsByDB = async (tableIdent: string) => {
                  const connId = currentConnectionIdRef.current;
                  const dbName = currentDbRef.current;
                  if (!connId || !dbName) return [] as ColumnDefinition[];
                  const key = `${connId}|${dbName}|${tableIdent}`;
                  const cached = columnsCacheRef.current[key];
                  if (cached) return cached;

                  const config = buildConnConfig();
                  if (!config) return [] as ColumnDefinition[];

                  const res = await DBGetColumns(config as any, dbName, tableIdent);
                  if (res?.success && Array.isArray(res.data)) {
                      const cols = res.data as ColumnDefinition[];
                      columnsCacheRef.current[key] = cols;
                      return cols;
                  }
                  return [] as ColumnDefinition[];
              };

              const fullText = model.getValue();

              // 1) alias.field completion: when cursor is after "<alias>.<prefix>"
              const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
              const qualifierMatch = linePrefix.match(/([`"]?[A-Za-z_][\w]*[`"]?)\.(\w*)$/);
              if (qualifierMatch) {
                  const alias = stripQuotes(qualifierMatch[1]);
                  const colPrefix = (qualifierMatch[2] || '').toLowerCase();

                  const reserved = new Set([
                      'where', 'on', 'group', 'order', 'limit', 'having',
                      'left', 'right', 'inner', 'outer', 'full', 'cross', 'join',
                      'union', 'except', 'intersect', 'as', 'set', 'values', 'returning',
                  ]);

                  const aliasMap: Record<string, string> = {};
                  // Capture table and optional alias, support schema.table
                  const aliasRegex = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([`"]?[\w]+[`"]?(?:\s*\.\s*[`"]?[\w]+[`"]?)?)(?:\s+(?:AS\s+)?([`"]?[\w]+[`"]?))?/gi;
                  let m;
                  while ((m = aliasRegex.exec(fullText)) !== null) {
                      const tableIdent = normalizeQualifiedName(m[1] || '');
                      if (!tableIdent) continue;
                      const shortTable = getLastPart(tableIdent);
                      // allow "table." as qualifier too
                      if (shortTable) aliasMap[shortTable.toLowerCase()] = tableIdent;

                      const a = stripQuotes(m[2] || '').trim();
                      if (!a) continue;
                      const al = a.toLowerCase();
                      if (reserved.has(al)) continue;
                      aliasMap[al] = tableIdent;
                  }

                  const tableIdent = aliasMap[alias.toLowerCase()];
                  if (tableIdent) {
                      const shortTable = getLastPart(tableIdent);

                      // Prefer preloaded MySQL all-columns cache
                      let cols: { name: string, type?: string, tableName?: string }[] = [];
                      if (allColumnsRef.current.length > 0) {
                          cols = allColumnsRef.current
                              .filter(c => (c.tableName || '').toLowerCase() === (shortTable || '').toLowerCase())
                              .map(c => ({ name: c.name, type: c.type, tableName: c.tableName }));
                      } else {
                          const dbCols = await getColumnsByDB(tableIdent);
                          cols = dbCols.map(c => ({ name: c.name, type: c.type, tableName: shortTable }));
                      }

                      const filtered = colPrefix
                          ? cols.filter(c => (c.name || '').toLowerCase().startsWith(colPrefix))
                          : cols;

                      const suggestions = filtered.map(c => ({
                          label: c.name,
                          kind: monaco.languages.CompletionItemKind.Field,
                          insertText: c.name,
                          detail: c.type ? `${c.type}${c.tableName ? ` (${c.tableName})` : ''}` : (c.tableName ? `(${c.tableName})` : ''),
                          range,
                          sortText: '0' + c.name
                      }));
                      return { suggestions };
                  }
              }

              // 2) global/table/column completion
              const tableRegex = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([`"]?[\w]+[`"]?(?:\s*\.\s*[`"]?[\w]+[`"]?)?)/gi;
              const foundTables = new Set<string>();
              let match;
              while ((match = tableRegex.exec(fullText)) !== null) {
                  const t = normalizeQualifiedName(match[1] || '');
                  if (!t) continue;
                  foundTables.add(getLastPart(t).toLowerCase());
              }

              const relevantColumns = allColumnsRef.current
                  .filter(c => foundTables.has((c.tableName || '').toLowerCase()))
                  .map(c => ({
                      label: c.name,
                      kind: monaco.languages.CompletionItemKind.Field,
                      insertText: c.name,
                      detail: `${c.type} (${c.tableName})`,
                      range,
                      sortText: '0' + c.name
                  }));

              const suggestions = [
                  ...['SELECT', 'FROM', 'WHERE', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP BY', 'ORDER BY', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'VALUES', 'SET', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'Add', 'MODIFY', 'CHANGE', 'COLUMN', 'KEY', 'PRIMARY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'AUTO_INCREMENT', 'COMMENT', 'SHOW', 'DESCRIBE', 'EXPLAIN'].map(k => ({
                      label: k,
                      kind: monaco.languages.CompletionItemKind.Keyword,
                      insertText: k,
                      range
                  })),
                  ...tablesRef.current.map(t => ({
                      label: t,
                      kind: monaco.languages.CompletionItemKind.Class,
                      insertText: t,
                      detail: 'Table',
                      range
                  })),
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

  const splitSQLStatements = (sql: string): string[] => {
    const text = (sql || '').replace(/\r\n/g, '\n');
    const statements: string[] = [];

    let cur = '';
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    let dollarTag: string | null = null; // postgres/kingbase: $$...$$ or $tag$...$tag$

    const push = () => {
        const s = cur.trim();
        if (s) statements.push(s);
        cur = '';
    };

    const isWS = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : '';
        const prev = i > 0 ? text[i - 1] : '';
        const next2 = i + 2 < text.length ? text[i + 2] : '';

        if (!inSingle && !inDouble && !inBacktick) {
            if (inLineComment) {
                cur += ch;
                if (ch === '\n') inLineComment = false;
                continue;
            }

            if (inBlockComment) {
                cur += ch;
                if (ch === '*' && next === '/') {
                    cur += next;
                    i++;
                    inBlockComment = false;
                }
                continue;
            }

            // Start comments
            if (ch === '/' && next === '*') {
                cur += ch + next;
                i++;
                inBlockComment = true;
                continue;
            }
            if (ch === '#') {
                cur += ch;
                inLineComment = true;
                continue;
            }
            if (ch === '-' && next === '-' && (i === 0 || isWS(prev)) && (next2 === '' || isWS(next2))) {
                cur += ch + next;
                i++;
                inLineComment = true;
                continue;
            }

            // Dollar-quoted strings (PG/Kingbase)
            if (dollarTag) {
                if (text.startsWith(dollarTag, i)) {
                    cur += dollarTag;
                    i += dollarTag.length - 1;
                    dollarTag = null;
                } else {
                    cur += ch;
                }
                continue;
            }
            if (ch === '$') {
                const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
                if (m && m[0]) {
                    dollarTag = m[0];
                    cur += dollarTag;
                    i += dollarTag.length - 1;
                    continue;
                }
            }
        }

        if (escaped) {
            cur += ch;
            escaped = false;
            continue;
        }

        if ((inSingle || inDouble) && ch === '\\') {
            cur += ch;
            escaped = true;
            continue;
        }

        if (!inDouble && !inBacktick && ch === '\'') {
            inSingle = !inSingle;
            cur += ch;
            continue;
        }
        if (!inSingle && !inBacktick && ch === '"') {
            inDouble = !inDouble;
            cur += ch;
            continue;
        }
        if (!inSingle && !inDouble && ch === '`') {
            inBacktick = !inBacktick;
            cur += ch;
            continue;
        }

        if (!inSingle && !inDouble && !inBacktick && !dollarTag && (ch === ';' || ch === '；')) {
            push();
            continue;
        }

        cur += ch;
    }

    push();
    return statements;
  };

  const getLeadingKeyword = (sql: string): string => {
      const text = (sql || '').replace(/\r\n/g, '\n');
      const isWS = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
      const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

      let inSingle = false;
      let inDouble = false;
      let inBacktick = false;
      let escaped = false;
      let inLineComment = false;
      let inBlockComment = false;
      let dollarTag: string | null = null;

      for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          const next = i + 1 < text.length ? text[i + 1] : '';
          const prev = i > 0 ? text[i - 1] : '';
          const next2 = i + 2 < text.length ? text[i + 2] : '';

          if (!inSingle && !inDouble && !inBacktick) {
              if (inLineComment) {
                  if (ch === '\n') inLineComment = false;
                  continue;
              }
              if (inBlockComment) {
                  if (ch === '*' && next === '/') {
                      i++;
                      inBlockComment = false;
                  }
                  continue;
              }

              if (ch === '/' && next === '*') {
                  i++;
                  inBlockComment = true;
                  continue;
              }
              if (ch === '#') {
                  inLineComment = true;
                  continue;
              }
              if (ch === '-' && next === '-' && (i === 0 || isWS(prev)) && (next2 === '' || isWS(next2))) {
                  i++;
                  inLineComment = true;
                  continue;
              }

              if (dollarTag) {
                  if (text.startsWith(dollarTag, i)) {
                      i += dollarTag.length - 1;
                      dollarTag = null;
                  }
                  continue;
              }
              if (ch === '$') {
                  const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
                  if (m && m[0]) {
                      dollarTag = m[0];
                      i += dollarTag.length - 1;
                      continue;
                  }
              }
          }

          if (escaped) {
              escaped = false;
              continue;
          }
          if ((inSingle || inDouble) && ch === '\\') {
              escaped = true;
              continue;
          }

          if (!inDouble && !inBacktick && ch === '\'') {
              inSingle = !inSingle;
              continue;
          }
          if (!inSingle && !inBacktick && ch === '"') {
              inDouble = !inDouble;
              continue;
          }
          if (!inSingle && !inDouble && ch === '`') {
              inBacktick = !inBacktick;
              continue;
          }

          if (inSingle || inDouble || inBacktick || dollarTag) continue;
          if (isWS(ch)) continue;

          if (isWord(ch)) {
              let j = i;
              while (j < text.length && isWord(text[j])) j++;
              return text.slice(i, j).toLowerCase();
          }
          return '';
      }
      return '';
  };

  const splitSqlTail = (sql: string): { main: string; tail: string } => {
      const text = (sql || '').replace(/\r\n/g, '\n');
      const isWS = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

      let inSingle = false;
      let inDouble = false;
      let inBacktick = false;
      let escaped = false;
      let inLineComment = false;
      let inBlockComment = false;
      let dollarTag: string | null = null;
      let lastMeaningful = -1;

      for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          const next = i + 1 < text.length ? text[i + 1] : '';
          const prev = i > 0 ? text[i - 1] : '';
          const next2 = i + 2 < text.length ? text[i + 2] : '';

          if (!inSingle && !inDouble && !inBacktick) {
              if (dollarTag) {
                  if (text.startsWith(dollarTag, i)) {
                      lastMeaningful = i + dollarTag.length - 1;
                      i += dollarTag.length - 1;
                      dollarTag = null;
                  } else if (!isWS(ch)) {
                      lastMeaningful = i;
                  }
                  continue;
              }
              if (inLineComment) {
                  if (ch === '\n') inLineComment = false;
                  continue;
              }
              if (inBlockComment) {
                  if (ch === '*' && next === '/') {
                      i++;
                      inBlockComment = false;
                  }
                  continue;
              }

              // Start comments
              if (ch === '/' && next === '*') {
                  i++;
                  inBlockComment = true;
                  continue;
              }
              if (ch === '#') {
                  inLineComment = true;
                  continue;
              }
              if (ch === '-' && next === '-' && (i === 0 || isWS(prev)) && (next2 === '' || isWS(next2))) {
                  i++;
                  inLineComment = true;
                  continue;
              }

              if (ch === '$') {
                  const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
                  if (m && m[0]) {
                      dollarTag = m[0];
                      lastMeaningful = i + dollarTag.length - 1;
                      i += dollarTag.length - 1;
                      continue;
                  }
              }
          }

          if (escaped) {
              escaped = false;
          } else if ((inSingle || inDouble) && ch === '\\') {
              escaped = true;
          } else {
              if (!inDouble && !inBacktick && ch === '\'') inSingle = !inSingle;
              else if (!inSingle && !inBacktick && ch === '"') inDouble = !inDouble;
              else if (!inSingle && !inDouble && ch === '`') inBacktick = !inBacktick;
          }

          if (!inLineComment && !inBlockComment && !isWS(ch)) {
              lastMeaningful = i;
          }
      }

      if (lastMeaningful < 0) return { main: '', tail: text };
      return { main: text.slice(0, lastMeaningful + 1), tail: text.slice(lastMeaningful + 1) };
  };

  const findTopLevelKeyword = (sql: string, keyword: string): number => {
      const text = sql;
      const kw = keyword.toLowerCase();
      const isWS = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
      const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

      let inSingle = false;
      let inDouble = false;
      let inBacktick = false;
      let escaped = false;
      let inLineComment = false;
      let inBlockComment = false;
      let dollarTag: string | null = null;
      let parenDepth = 0;

      for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          const next = i + 1 < text.length ? text[i + 1] : '';
          const prev = i > 0 ? text[i - 1] : '';
          const next2 = i + 2 < text.length ? text[i + 2] : '';

          if (!inSingle && !inDouble && !inBacktick) {
              if (inLineComment) {
                  if (ch === '\n') inLineComment = false;
                  continue;
              }
              if (inBlockComment) {
                  if (ch === '*' && next === '/') {
                      i++;
                      inBlockComment = false;
                  }
                  continue;
              }

              if (ch === '/' && next === '*') {
                  i++;
                  inBlockComment = true;
                  continue;
              }
              if (ch === '#') {
                  inLineComment = true;
                  continue;
              }
              if (ch === '-' && next === '-' && (i === 0 || isWS(prev)) && (next2 === '' || isWS(next2))) {
                  i++;
                  inLineComment = true;
                  continue;
              }

              if (dollarTag) {
                  if (text.startsWith(dollarTag, i)) {
                      i += dollarTag.length - 1;
                      dollarTag = null;
                  }
                  continue;
              }
              if (ch === '$') {
                  const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
                  if (m && m[0]) {
                      dollarTag = m[0];
                      i += dollarTag.length - 1;
                      continue;
                  }
              }
          }

          if (escaped) {
              escaped = false;
              continue;
          }
          if ((inSingle || inDouble) && ch === '\\') {
              escaped = true;
              continue;
          }

          if (!inDouble && !inBacktick && ch === '\'') {
              inSingle = !inSingle;
              continue;
          }
          if (!inSingle && !inBacktick && ch === '"') {
              inDouble = !inDouble;
              continue;
          }
          if (!inSingle && !inDouble && ch === '`') {
              inBacktick = !inBacktick;
              continue;
          }

          if (inSingle || inDouble || inBacktick || dollarTag) continue;

          if (ch === '(') { parenDepth++; continue; }
          if (ch === ')') { if (parenDepth > 0) parenDepth--; continue; }
          if (parenDepth !== 0) continue;

          if (!isWord(ch)) continue;

          if (text.slice(i, i + kw.length).toLowerCase() !== kw) continue;
          const before = i - 1 >= 0 ? text[i - 1] : '';
          const after = i + kw.length < text.length ? text[i + kw.length] : '';
          if ((before && isWord(before)) || (after && isWord(after))) continue;
          return i;
      }
      return -1;
  };

  const applyAutoLimit = (sql: string, dbType: string, maxRows: number): { sql: string; applied: boolean; maxRows: number } => {
      const normalizedType = (dbType || 'mysql').toLowerCase();
      const supportsLimit = normalizedType === 'mysql' || normalizedType === 'postgres' || normalizedType === 'kingbase' || normalizedType === 'sqlite' || normalizedType === '';
      if (!supportsLimit) return { sql, applied: false, maxRows };
      if (!Number.isFinite(maxRows) || maxRows <= 0) return { sql, applied: false, maxRows };

      const { main, tail } = splitSqlTail(sql);
      if (!main.trim()) return { sql, applied: false, maxRows };

      const fromPos = findTopLevelKeyword(main, 'from');
      const limitPos = findTopLevelKeyword(main, 'limit');
      if (limitPos >= 0 && (fromPos < 0 || limitPos > fromPos)) return { sql, applied: false, maxRows };
      const fetchPos = findTopLevelKeyword(main, 'fetch');
      if (fetchPos >= 0 && (fromPos < 0 || fetchPos > fromPos)) return { sql, applied: false, maxRows };

      const offsetPos = findTopLevelKeyword(main, 'offset');
      const forPos = findTopLevelKeyword(main, 'for');
      const lockPos = findTopLevelKeyword(main, 'lock');

      const candidates = [offsetPos, forPos, lockPos]
          .filter(pos => pos >= 0 && (fromPos < 0 || pos > fromPos));

      const insertAt = candidates.length > 0 ? Math.min(...candidates) : main.length;
      const before = main.slice(0, insertAt).trimEnd();
      const after = main.slice(insertAt).trimStart();
      const nextMain = [before, `LIMIT ${maxRows}`, after].filter(Boolean).join(' ').trim();
      return { sql: nextMain + tail, applied: true, maxRows };
  };

  const getSelectedSQL = (): string => {
      const editor = editorRef.current;
      if (!editor) return '';
      const model = editor.getModel?.();
      const selection = editor.getSelection?.();
      if (!model || !selection) return '';

      const selected = model.getValueInRange?.(selection) || '';
      if (typeof selected !== 'string') return '';
      if (!selected.trim()) return '';
      return selected;
  };

  const handleRun = async () => {
    if (!query.trim()) return;
    if (!currentDb) {
        message.error("请先选择数据库");
        return;
    }
    const runSeq = ++runSeqRef.current;
    setLoading(true);
    const runStartTime = Date.now();
    const conn = connections.find(c => c.id === currentConnectionId);
    if (!conn) {
        message.error("Connection not found");
        if (runSeqRef.current === runSeq) setLoading(false);
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

    try {
        const rawSQL = getSelectedSQL() || query;
        const statements = splitSQLStatements(rawSQL);
        if (statements.length === 0) {
            message.info('没有可执行的 SQL。');
            setResultSets([]);
            setActiveResultKey('');
            return;
        }

        const nextResultSets: ResultSet[] = [];
        const maxRows = Number(queryOptions?.maxRows) || 0;
        const dbType = String((config as any).type || 'mysql');
        const wantsLimitProbe = Number.isFinite(maxRows) && maxRows > 0;
        const probeLimit = wantsLimitProbe ? (maxRows + 1) : 0;
        let anyTruncated = false;
        const pendingPk: Array<{ resultKey: string; tableName: string }> = [];

        for (let idx = 0; idx < statements.length; idx++) {
            const rawStatement = statements[idx];
            const leadingKeyword = getLeadingKeyword(rawStatement);
            const shouldAutoLimit = leadingKeyword === 'select' || leadingKeyword === 'with';

            const limitApplied = shouldAutoLimit && wantsLimitProbe;
            const limited = limitApplied ? applyAutoLimit(rawStatement, dbType, probeLimit) : { sql: rawStatement, applied: false, maxRows: probeLimit };
            const executedSql = limited.sql;
            const startTime = Date.now();
            const res = await DBQuery(config as any, currentDb, executedSql);
            const duration = Date.now() - startTime;

            addSqlLog({
                id: `log-${Date.now()}-query-${idx + 1}`,
                timestamp: Date.now(),
                sql: executedSql,
                status: res.success ? 'success' : 'error',
                duration,
                message: res.success ? '' : res.message,
                affectedRows: (res.success && !Array.isArray(res.data)) ? (res.data as any).affectedRows : (Array.isArray(res.data) ? res.data.length : undefined),
                dbName: currentDb
            });

            if (!res.success) {
                const prefix = statements.length > 1 ? `第 ${idx + 1} 条语句执行失败：` : '';
                message.error(prefix + res.message);
                setResultSets([]);
                setActiveResultKey('');
                return;
            }

            if (Array.isArray(res.data)) {
                let rows = (res.data as any[]) || [];
                let truncated = false;
                if (limited.applied && Number.isFinite(maxRows) && maxRows > 0 && rows.length > maxRows) {
                    truncated = true;
                    anyTruncated = true;
                    rows = rows.slice(0, maxRows);
                }
                const cols = (res.fields && res.fields.length > 0)
                    ? (res.fields as string[])
                    : (rows.length > 0 ? Object.keys(rows[0]) : []);

                rows.forEach((row: any, i: number) => {
                    if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = i;
                });

                let simpleTableName: string | undefined = undefined;
                const tableMatch = rawStatement.match(/^\s*SELECT\s+\*\s+FROM\s+[`"]?(\w+)[`"]?\s*(?:WHERE.*)?(?:ORDER BY.*)?(?:LIMIT.*)?$/i);
                if (tableMatch) {
                    simpleTableName = tableMatch[1];
                    pendingPk.push({ resultKey: `result-${idx + 1}`, tableName: simpleTableName });
                }

                nextResultSets.push({
                    key: `result-${idx + 1}`,
                    sql: rawStatement,
                    rows,
                    columns: cols,
                    tableName: simpleTableName,
                    pkColumns: [],
                    readOnly: true,
                    pkLoading: !!simpleTableName,
                    truncated
                });
            } else {
                const affected = Number((res.data as any)?.affectedRows);
                if (Number.isFinite(affected)) {
                    const row = { affectedRows: affected };
                    (row as any)[GONAVI_ROW_KEY] = 0;
                    nextResultSets.push({
                        key: `result-${idx + 1}`,
                        sql: rawStatement,
                        rows: [row],
                        columns: ['affectedRows'],
                        pkColumns: [],
                        readOnly: true
                    });
                }
            }
        }

        setResultSets(nextResultSets);
        setActiveResultKey(nextResultSets[0]?.key || '');

        pendingPk.forEach(({ resultKey, tableName }) => {
            DBGetColumns(config as any, currentDb, tableName)
                .then((resCols: any) => {
                    if (runSeqRef.current !== runSeq) return;
                    if (!resCols?.success) {
                        setResultSets(prev => prev.map(rs => rs.key === resultKey ? { ...rs, pkLoading: false, readOnly: false } : rs));
                        return;
                    }
                    const primaryKeys = (resCols.data as ColumnDefinition[]).filter(c => c.key === 'PRI').map(c => c.name);
                    setResultSets(prev => prev.map(rs => rs.key === resultKey ? { ...rs, pkColumns: primaryKeys, pkLoading: false, readOnly: false } : rs));
                })
                .catch(() => {
                    if (runSeqRef.current !== runSeq) return;
                    setResultSets(prev => prev.map(rs => rs.key === resultKey ? { ...rs, pkLoading: false, readOnly: false } : rs));
                });
        });

        if (statements.length > 1) {
            message.success(`已执行 ${statements.length} 条语句，生成 ${nextResultSets.length} 个结果集。`);
        } else if (nextResultSets.length === 0) {
            message.success('执行成功。');
        }
        if (anyTruncated && maxRows > 0) {
            message.warning(`结果集已自动限制为最多 ${maxRows} 行（可在工具栏调整）。`);
        }
    } catch (e: any) {
        message.error("Error executing query: " + e.message);
        addSqlLog({
            id: `log-${Date.now()}-error`,
            timestamp: Date.now(),
            sql: getSelectedSQL() || query,
            status: 'error',
            duration: Date.now() - runStartTime,
            message: e.message,
            dbName: currentDb
        });
        setResultSets([]);
        setActiveResultKey('');
    } finally {
        if (runSeqRef.current === runSeq) setLoading(false);
    }
  };

  const handleSave = async () => {
      try {
          const values = await saveForm.validateFields();
          saveQuery({
              id: tab.id.startsWith('saved-') ? tab.id : `saved-${Date.now()}`,
              name: values.name,
              sql: query,
              connectionId: currentConnectionId,
              dbName: currentDb || tab.dbName || '',
              createdAt: Date.now()
          });
          message.success('查询已保存！');
          setIsSaveModalOpen(false);
      } catch (e) {
      }
  };

  const handleCloseResult = (key: string) => {
      setResultSets(prev => {
          const idx = prev.findIndex(r => r.key === key);
          if (idx < 0) return prev;
          const next = prev.filter(r => r.key !== key);

          setActiveResultKey(prevActive => {
              if (prevActive && prevActive !== key) return prevActive;
              const nextKey = next[idx]?.key || next[idx - 1]?.key || next[0]?.key || '';
              return nextKey;
          });

          return next;
      });
  };

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <style>{`
        .query-result-tabs {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .query-result-tabs .ant-tabs-nav {
          flex: 0 0 auto;
        }
        .query-result-tabs .ant-tabs-content-holder {
          flex: 1 1 auto;
          overflow: hidden;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .query-result-tabs .ant-tabs-content {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .query-result-tabs .ant-tabs-tabpane {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .query-result-tabs .ant-tabs-tabpane > div {
          flex: 1 1 auto;
          min-height: 0;
        }
        .query-result-tabs .ant-tabs-tabpane-hidden {
          display: none !important;
        }
        .query-result-tabs .ant-tabs-ink-bar {
          transition: none !important;
        }
      `}</style>
      <div style={{ padding: '8px', borderBottom: '1px solid #eee', display: 'flex', gap: '8px', flexShrink: 0, alignItems: 'center' }}>
        <Select 
            style={{ width: 150 }} 
            placeholder="选择连接"
            value={currentConnectionId}
            onChange={(val) => {
                setCurrentConnectionId(val);
                setCurrentDb('');
            }}
            options={connections.map(c => ({ label: c.name, value: c.id }))}
            showSearch
        />
        <Select 
            style={{ width: 200 }} 
            placeholder="选择数据库"
            value={currentDb}
            onChange={setCurrentDb}
            options={dbList.map(db => ({ label: db, value: db }))}
            showSearch
        />
        <Tooltip title="最大返回行数（会对 SELECT 自动加 LIMIT，防止大结果集卡死）">
            <Select
                style={{ width: 170 }}
                value={queryOptions?.maxRows ?? 5000}
                onChange={(val) => setQueryOptions({ maxRows: Number(val) })}
                options={[
                    { label: '最大行数：500', value: 500 },
                    { label: '最大行数：1000', value: 1000 },
                    { label: '最大行数：5000', value: 5000 },
                    { label: '最大行数：20000', value: 20000 },
                    { label: '最大行数：不限', value: 0 },
                ]}
            />
        </Tooltip>
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

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column' }}>
        {resultSets.length > 0 ? (
          <Tabs
              className="query-result-tabs"
              activeKey={activeResultKey || resultSets[0]?.key}
              onChange={setActiveResultKey}
              animated={false}
              style={{ flex: 1, minHeight: 0 }}
              items={resultSets.map((rs, idx) => ({
                  key: rs.key,
                  label: (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Tooltip title={rs.sql}>
                              <span>{`结果 ${idx + 1}${Array.isArray(rs.rows) ? ` (${rs.rows.length}${rs.truncated ? '+' : ''})` : ''}`}</span>
                          </Tooltip>
                          <Tooltip title="关闭结果">
                              <span
                                  onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleCloseResult(rs.key);
                                  }}
                                  style={{ display: 'inline-flex', alignItems: 'center', color: '#999', cursor: 'pointer' }}
                              >
                                  <CloseOutlined style={{ fontSize: 12 }} />
                              </span>
                          </Tooltip>
                      </div>
                  ),
                  children: (
                      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                          <DataGrid
                              data={rs.rows}
                              columnNames={rs.columns}
                              loading={loading}
                              tableName={rs.tableName}
                              dbName={currentDb}
                              connectionId={currentConnectionId}
                              pkColumns={rs.pkColumns}
                              onReload={handleRun}
                              readOnly={rs.readOnly}
                          />
                      </div>
                  )
              }))}
          />
        ) : (
          <div style={{ flex: 1, minHeight: 0 }} />
        )}
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
