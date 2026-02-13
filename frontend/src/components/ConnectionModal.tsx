import React, { useState, useEffect, useRef } from 'react';
import { Modal, Form, Input, InputNumber, Button, message, Checkbox, Divider, Select, Alert, Card, Row, Col, Typography, Collapse, Space, Table, Tag } from 'antd';
import { DatabaseOutlined, ConsoleSqlOutlined, FileTextOutlined, CloudServerOutlined, AppstoreAddOutlined, CloudOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { useStore } from '../store';
import { DBGetDatabases, GetDriverStatusList, MongoDiscoverMembers, TestConnection, RedisConnect } from '../../wailsjs/go/app/App';
import { MongoMemberInfo, SavedConnection } from '../types';

const { Meta } = Card;
const { Text } = Typography;
const MAX_URI_LENGTH = 4096;
const MAX_URI_HOSTS = 32;
const MAX_TIMEOUT_SECONDS = 3600;

const getDefaultPortByType = (type: string) => {
  switch (type) {
    case 'mysql': return 3306;
    case 'diros': return 9030;
    case 'sphinx': return 9306;
    case 'postgres': return 5432;
    case 'redis': return 6379;
    case 'tdengine': return 6041;
    case 'oracle': return 1521;
    case 'dameng': return 5236;
    case 'kingbase': return 54321;
    case 'sqlserver': return 1433;
    case 'mongodb': return 27017;
    case 'highgo': return 5866;
    case 'mariadb': return 3306;
    case 'vastbase': return 5432;
    case 'duckdb': return 0;
    default: return 3306;
  }
};

const isFileDatabaseType = (type: string) => type === 'sqlite' || type === 'duckdb';

type DriverStatusSnapshot = {
  type: string;
  name: string;
  connectable: boolean;
  message?: string;
};

const normalizeDriverType = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'postgresql') return 'postgres';
  if (normalized === 'doris') return 'diros';
  return normalized;
};

const ConnectionModal: React.FC<{
  open: boolean;
  onClose: () => void;
  initialValues?: SavedConnection | null;
  onOpenDriverManager?: () => void;
}> = ({ open, onClose, initialValues, onOpenDriverManager }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [useSSH, setUseSSH] = useState(false);
  const [dbType, setDbType] = useState('mysql');
  const [step, setStep] = useState(1); // 1: Select Type, 2: Configure
  const [activeGroup, setActiveGroup] = useState(0); // Active category index in step 1
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [testErrorLogOpen, setTestErrorLogOpen] = useState(false);
  const [dbList, setDbList] = useState<string[]>([]);
  const [redisDbList, setRedisDbList] = useState<number[]>([]); // Redis databases 0-15
  const [mongoMembers, setMongoMembers] = useState<MongoMemberInfo[]>([]);
  const [discoveringMembers, setDiscoveringMembers] = useState(false);
  const [uriFeedback, setUriFeedback] = useState<{ type: 'success' | 'warning' | 'error'; message: string } | null>(null);
  const [typeSelectWarning, setTypeSelectWarning] = useState<{ driverName: string; reason: string } | null>(null);
  const [driverStatusMap, setDriverStatusMap] = useState<Record<string, DriverStatusSnapshot>>({});
  const [driverStatusLoaded, setDriverStatusLoaded] = useState(false);
  const testInFlightRef = useRef(false);
  const testTimerRef = useRef<number | null>(null);
  const addConnection = useStore((state) => state.addConnection);
  const updateConnection = useStore((state) => state.updateConnection);
  const mysqlTopology = Form.useWatch('mysqlTopology', form) || 'single';
  const mongoTopology = Form.useWatch('mongoTopology', form) || 'single';
  const mongoSrv = Form.useWatch('mongoSrv', form) || false;

  const fetchDriverStatusMap = async (): Promise<Record<string, DriverStatusSnapshot>> => {
      const result: Record<string, DriverStatusSnapshot> = {};
      const res = await GetDriverStatusList('', '');
      if (!res?.success) {
          return result;
      }
      const data = (res?.data || {}) as any;
      const drivers = Array.isArray(data.drivers) ? data.drivers : [];
      drivers.forEach((item: any) => {
          const type = normalizeDriverType(String(item.type || '').trim());
          if (!type) return;
          result[type] = {
              type,
              name: String(item.name || item.type || type).trim(),
              connectable: !!item.connectable,
              message: String(item.message || '').trim() || undefined,
          };
      });
      return result;
  };

  const refreshDriverStatus = async () => {
      try {
          const next = await fetchDriverStatusMap();
          setDriverStatusMap(next);
      } catch {
          setDriverStatusMap({});
      } finally {
          setDriverStatusLoaded(true);
      }
  };

  const resolveDriverUnavailableReason = async (type: string): Promise<string> => {
      const normalized = normalizeDriverType(type);
      if (!normalized || normalized === 'custom') {
          return '';
      }
      let snapshot = driverStatusMap;
      if (!snapshot[normalized]) {
          snapshot = await fetchDriverStatusMap();
          setDriverStatusMap(snapshot);
      }
      const status = snapshot[normalized];
      if (!status || status.connectable) {
          return '';
      }
      return status.message || `${status.name || normalized} 驱动未安装启用，请先在驱动管理中安装`;
  };

  const promptInstallDriver = (driverType: string, reason: string) => {
      const normalized = normalizeDriverType(driverType);
      const snapshot = driverStatusMap[normalized];
      const driverName = snapshot?.name || normalized || '当前';
      Modal.confirm({
          title: `${driverName} 驱动不可用`,
          content: reason || `${driverName} 驱动未安装启用，请先在驱动管理中安装`,
          okText: '去驱动管理安装',
          cancelText: '取消',
          onOk: () => {
              onOpenDriverManager?.();
          },
      });
  };

  const parseHostPort = (raw: string, defaultPort: number): { host: string; port: number } | null => {
      const text = String(raw || '').trim();
      if (!text) {
          return null;
      }
      if (text.startsWith('[')) {
          const closingBracket = text.indexOf(']');
          if (closingBracket > 0) {
              const host = text.slice(1, closingBracket).trim();
              const portText = text.slice(closingBracket + 1).trim().replace(/^:/, '');
              const parsedPort = Number(portText);
              return {
                  host: host || 'localhost',
                  port: Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : defaultPort,
              };
          }
      }

      const colonCount = (text.match(/:/g) || []).length;
      if (colonCount === 1) {
          const splitIndex = text.lastIndexOf(':');
          const host = text.slice(0, splitIndex).trim();
          const portText = text.slice(splitIndex + 1).trim();
          const parsedPort = Number(portText);
          return {
              host: host || 'localhost',
              port: Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : defaultPort,
          };
      }

      return { host: text, port: defaultPort };
  };

  const toAddress = (host: string, port: number, defaultPort: number) => {
      const safeHost = String(host || '').trim() || 'localhost';
      const safePort = Number.isFinite(Number(port)) && Number(port) > 0 ? Number(port) : defaultPort;
      return `${safeHost}:${safePort}`;
  };

  const normalizeAddressList = (rawList: unknown, defaultPort: number): string[] => {
      const list = Array.isArray(rawList) ? rawList : [];
      const seen = new Set<string>();
      const result: string[] = [];
      list.forEach((entry) => {
          const parsed = parseHostPort(String(entry || ''), defaultPort);
          if (!parsed) {
              return;
          }
          const normalized = toAddress(parsed.host, parsed.port, defaultPort);
          if (seen.has(normalized)) {
              return;
          }
          seen.add(normalized);
          result.push(normalized);
      });
      return result;
  };

  const isValidUriHostEntry = (entry: string): boolean => {
      const text = String(entry || '').trim();
      if (!text) return false;
      if (text.length > 255) return false;
      // 拒绝明显的 DSN 片段或路径/空白，避免把非 URI 主机段误判为合法地址。
      if (/[()\\/\s]/.test(text)) return false;
      return true;
  };

  const normalizeMongoSrvHostList = (rawList: unknown, defaultPort: number): string[] => {
      const list = Array.isArray(rawList) ? rawList : [];
      const seen = new Set<string>();
      const result: string[] = [];
      list.forEach((entry) => {
          const parsed = parseHostPort(String(entry || ''), defaultPort);
          if (!parsed?.host) {
              return;
          }
          const host = String(parsed.host).trim();
          if (!host || seen.has(host)) {
              return;
          }
          seen.add(host);
          result.push(host);
      });
      return result;
  };

  const safeDecode = (text: string) => {
      try {
          return decodeURIComponent(text);
      } catch {
          return text;
      }
  };

  const parseMultiHostUri = (uriText: string, expectedScheme: string) => {
      const prefix = `${expectedScheme}://`;
      if (!uriText.toLowerCase().startsWith(prefix)) {
          return null;
      }
      let rest = uriText.slice(prefix.length);
      const hashIndex = rest.indexOf('#');
      if (hashIndex >= 0) {
          rest = rest.slice(0, hashIndex);
      }
      let queryText = '';
      const queryIndex = rest.indexOf('?');
      if (queryIndex >= 0) {
          queryText = rest.slice(queryIndex + 1);
          rest = rest.slice(0, queryIndex);
      }

      let pathText = '';
      const slashIndex = rest.indexOf('/');
      if (slashIndex >= 0) {
          pathText = rest.slice(slashIndex + 1);
          rest = rest.slice(0, slashIndex);
      }

      let hostText = rest;
      let username = '';
      let password = '';
      const atIndex = rest.lastIndexOf('@');
      if (atIndex >= 0) {
          const userInfo = rest.slice(0, atIndex);
          hostText = rest.slice(atIndex + 1);
          const colonIndex = userInfo.indexOf(':');
          if (colonIndex >= 0) {
              username = safeDecode(userInfo.slice(0, colonIndex));
              password = safeDecode(userInfo.slice(colonIndex + 1));
          } else {
              username = safeDecode(userInfo);
          }
      }

      const hosts = hostText
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);

      return {
          username,
          password,
          hosts,
          database: safeDecode(pathText),
          params: new URLSearchParams(queryText),
      };
  };

  const parseUriToValues = (uriText: string, type: string): Record<string, any> | null => {
      const trimmedUri = String(uriText || '').trim();
      if (!trimmedUri) {
          return null;
      }
      if (trimmedUri.length > MAX_URI_LENGTH) {
          return null;
      }

      if (type === 'mysql' || type === 'mariadb' || type === 'diros' || type === 'sphinx') {
          const mysqlDefaultPort = getDefaultPortByType(type);
          const parsed = parseMultiHostUri(trimmedUri, 'mysql')
              || parseMultiHostUri(trimmedUri, 'diros')
              || parseMultiHostUri(trimmedUri, 'doris');
          if (!parsed) {
              return null;
          }
          if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
              return null;
          }
          if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
              return null;
          }
          const hostList = normalizeAddressList(parsed.hosts, mysqlDefaultPort);
          if (!hostList.length) {
              return null;
          }
          const primary = parseHostPort(hostList[0] || `localhost:${mysqlDefaultPort}`, mysqlDefaultPort);
          const timeoutValue = Number(parsed.params.get('timeout'));
          const topology = String(parsed.params.get('topology') || '').toLowerCase();
          return {
              host: primary?.host || 'localhost',
              port: primary?.port || mysqlDefaultPort,
              user: parsed.username,
              password: parsed.password,
              database: parsed.database || '',
              mysqlTopology: hostList.length > 1 || topology === 'replica' ? 'replica' : 'single',
              mysqlReplicaHosts: hostList.slice(1),
              timeout: Number.isFinite(timeoutValue) && timeoutValue > 0
                  ? Math.min(3600, Math.trunc(timeoutValue))
                  : undefined,
          };
      }

      if (isFileDatabaseType(type)) {
          const tryExtractPath = (uri: string, scheme: string): string | null => {
              const parsed = parseMultiHostUri(uri, scheme);
              if (!parsed) {
                  return null;
              }
              const host = String(parsed.hosts?.[0] || '').trim();
              const dbPath = String(parsed.database || '').trim();
              if (host && dbPath) {
                  return `/${host}/${dbPath}`.replace(/\/+/g, '/');
              }
              if (host) {
                  return `/${host}`.replace(/\/+/g, '/');
              }
              if (dbPath) {
                  return dbPath.startsWith('/') ? dbPath : `/${dbPath}`;
              }
              return null;
          };

          const pathFromScheme = tryExtractPath(trimmedUri, type);
          if (pathFromScheme) {
              return { host: decodeURIComponent(pathFromScheme) };
          }

          const rawPath = trimmedUri
              .replace(/^sqlite:\/\//i, '')
              .replace(/^duckdb:\/\//i, '')
              .trim();
          if (!rawPath) {
              return null;
          }
          return { host: decodeURIComponent(rawPath) };
      }

      if (type === 'mongodb') {
          const parsed = parseMultiHostUri(trimmedUri, 'mongodb') || parseMultiHostUri(trimmedUri, 'mongodb+srv');
          if (!parsed) {
              return null;
          }
          if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
              return null;
          }
          if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
              return null;
          }
          const isSrv = trimmedUri.toLowerCase().startsWith('mongodb+srv://');
          const hostList = isSrv
              ? normalizeMongoSrvHostList(parsed.hosts, 27017)
              : normalizeAddressList(parsed.hosts, 27017);
          if (!hostList.length) {
              return null;
          }
          const primary = isSrv
              ? { host: hostList[0] || 'localhost', port: 27017 }
              : parseHostPort(hostList[0] || 'localhost:27017', 27017);
          const timeoutMs = Number(parsed.params.get('connectTimeoutMS') || parsed.params.get('serverSelectionTimeoutMS'));
          return {
              host: primary?.host || 'localhost',
              port: primary?.port || 27017,
              user: parsed.username,
              password: parsed.password,
              database: parsed.database || '',
              mongoTopology: hostList.length > 1 || !!parsed.params.get('replicaSet') ? 'replica' : 'single',
              mongoHosts: hostList.slice(1),
              mongoSrv: isSrv,
              mongoReplicaSet: parsed.params.get('replicaSet') || '',
              mongoAuthSource: parsed.params.get('authSource') || '',
              mongoReadPreference: parsed.params.get('readPreference') || 'primary',
              mongoAuthMechanism: parsed.params.get('authMechanism') || '',
              timeout: Number.isFinite(timeoutMs) && timeoutMs > 0
                  ? Math.min(MAX_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1000))
                  : undefined,
              savePassword: true,
          };
      }

      return null;
  };

  const createUriAwareRequiredRule = (
      messageText: string,
      validateValue?: (value: unknown) => boolean
  ) => ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
      validator(_: unknown, value: unknown) {
          const uriText = String(getFieldValue('uri') || '').trim();
          const type = String(getFieldValue('type') || dbType).trim().toLowerCase();
          if (uriText && parseUriToValues(uriText, type)) {
              return Promise.resolve();
          }
          const valid = validateValue
              ? validateValue(value)
              : String(value ?? '').trim() !== '';
          return valid ? Promise.resolve() : Promise.reject(new Error(messageText));
      }
  });

  const getUriPlaceholder = () => {
      if (dbType === 'mysql' || dbType === 'mariadb' || dbType === 'diros' || dbType === 'sphinx') {
          const defaultPort = getDefaultPortByType(dbType);
          const scheme = dbType === 'diros' ? 'diros' : 'mysql';
          return `${scheme}://user:pass@127.0.0.1:${defaultPort},127.0.0.2:${defaultPort}/db_name?topology=replica`;
      }
      if (isFileDatabaseType(dbType)) {
          return dbType === 'duckdb'
              ? 'duckdb:///Users/name/demo.duckdb'
              : 'sqlite:///Users/name/demo.sqlite';
      }
      if (dbType === 'mongodb') {
          return 'mongodb+srv://user:pass@cluster0.example.com/db_name?authSource=admin&authMechanism=SCRAM-SHA-256';
      }
      return '例如: postgres://user:pass@127.0.0.1:5432/db_name';
  };

  const buildUriFromValues = (values: any) => {
      const type = String(values.type || '').trim().toLowerCase();
      const defaultPort = getDefaultPortByType(type);
      const host = String(values.host || 'localhost').trim();
      const port = Number(values.port || defaultPort);
      const user = String(values.user || '').trim();
      const password = String(values.password || '');
      const database = String(values.database || '').trim();
      const timeout = Number(values.timeout || 30);
      const encodedAuth = user
          ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@`
          : '';

      if (type === 'mysql' || type === 'mariadb' || type === 'diros' || type === 'sphinx') {
          const primary = toAddress(host, port, defaultPort);
          const replicas = values.mysqlTopology === 'replica'
              ? normalizeAddressList(values.mysqlReplicaHosts, defaultPort)
              : [];
          const hosts = normalizeAddressList([primary, ...replicas], defaultPort);
          const params = new URLSearchParams();
          if (hosts.length > 1 || values.mysqlTopology === 'replica') {
              params.set('topology', 'replica');
          }
          if (Number.isFinite(timeout) && timeout > 0) {
              params.set('timeout', String(timeout));
          }
          const dbPath = database ? `/${encodeURIComponent(database)}` : '/';
          const query = params.toString();
          const scheme = type === 'diros' ? 'diros' : 'mysql';
          return `${scheme}://${encodedAuth}${hosts.join(',')}${dbPath}${query ? `?${query}` : ''}`;
      }

      if (isFileDatabaseType(type)) {
          const pathText = String(values.host || '').trim();
          if (!pathText) {
              return `${type}://`;
          }
          const normalizedPath = pathText.startsWith('/') ? pathText : `/${pathText}`;
          return `${type}://${encodeURI(normalizedPath)}`;
      }

      if (type === 'mongodb') {
          const useSrv = !!values.mongoSrv;
          const primaryAddress = useSrv
              ? (parseHostPort(host, 27017)?.host || host || 'localhost')
              : toAddress(host, port, 27017);
          const extraNodes = values.mongoTopology === 'replica'
              ? (useSrv ? normalizeMongoSrvHostList(values.mongoHosts, 27017) : normalizeAddressList(values.mongoHosts, 27017))
              : [];
          const hosts = useSrv
              ? normalizeMongoSrvHostList([primaryAddress, ...extraNodes], 27017)
              : normalizeAddressList([primaryAddress, ...extraNodes], 27017);
          const scheme = useSrv ? 'mongodb+srv' : 'mongodb';
          const params = new URLSearchParams();
          const authSource = String(values.mongoAuthSource || database || 'admin').trim();
          if (authSource) {
              params.set('authSource', authSource);
          }
          const replicaSet = String(values.mongoReplicaSet || '').trim();
          if (replicaSet) {
              params.set('replicaSet', replicaSet);
          }
          const readPreference = String(values.mongoReadPreference || '').trim();
          if (readPreference) {
              params.set('readPreference', readPreference);
          }
          const authMechanism = String(values.mongoAuthMechanism || '').trim();
          if (authMechanism) {
              params.set('authMechanism', authMechanism);
          }
          if (Number.isFinite(timeout) && timeout > 0) {
              params.set('connectTimeoutMS', String(timeout * 1000));
              params.set('serverSelectionTimeoutMS', String(timeout * 1000));
          }
          const dbPath = database ? `/${encodeURIComponent(database)}` : '/';
          const query = params.toString();
          return `${scheme}://${encodedAuth}${hosts.join(',')}${dbPath}${query ? `?${query}` : ''}`;
      }

      const scheme = type === 'postgres' ? 'postgresql' : type;
      const dbPath = database ? `/${encodeURIComponent(database)}` : '';
      return `${scheme}://${encodedAuth}${toAddress(host, port, defaultPort)}${dbPath}`;
  };

  const handleGenerateURI = () => {
      try {
          const values = form.getFieldsValue(true);
          const uri = buildUriFromValues(values);
          form.setFieldValue('uri', uri);
          setUriFeedback({ type: 'success', message: 'URI 已生成' });
      } catch {
          setUriFeedback({ type: 'error', message: '生成 URI 失败' });
      }
  };

  const handleParseURI = () => {
      try {
          const uriText = String(form.getFieldValue('uri') || '').trim();
          const type = String(form.getFieldValue('type') || dbType).trim().toLowerCase();
          if (!uriText) {
              setUriFeedback({ type: 'warning', message: '请先输入 URI' });
              return;
          }
          const parsedValues = parseUriToValues(uriText, type);
          if (!parsedValues) {
              setUriFeedback({ type: 'error', message: '当前 URI 与数据源类型不匹配，或 URI 格式不支持' });
              return;
          }
          form.setFieldsValue({ ...parsedValues, uri: uriText });
          if (testResult) {
              setTestResult(null);
          }
          setUriFeedback({ type: 'success', message: '已根据 URI 回填连接参数' });
      } catch {
          setUriFeedback({ type: 'error', message: 'URI 解析失败，请检查格式后重试' });
      }
  };

  const handleCopyURI = async () => {
      let uriText = String(form.getFieldValue('uri') || '').trim();
      if (!uriText) {
          const values = form.getFieldsValue(true);
          uriText = buildUriFromValues(values);
          form.setFieldValue('uri', uriText);
      }
      if (!uriText) {
          setUriFeedback({ type: 'warning', message: '没有可复制的 URI' });
          return;
      }
      try {
          await navigator.clipboard.writeText(uriText);
          setUriFeedback({ type: 'success', message: 'URI 已复制' });
      } catch {
          setUriFeedback({ type: 'error', message: '复制失败' });
      }
  };

  useEffect(() => {
      if (open) {
          setTestResult(null); // Reset test result
          setTestErrorLogOpen(false);
          setDbList([]);
          setRedisDbList([]);
          setMongoMembers([]);
          setUriFeedback(null);
          setTypeSelectWarning(null);
          setDriverStatusLoaded(false);
          void refreshDriverStatus();
          if (initialValues) {
              // Edit mode: Go directly to step 2
              setStep(2);
              const config: any = initialValues.config || {};
              const configType = String(config.type || 'mysql');
              const defaultPort = getDefaultPortByType(configType);
              const normalizedHosts = normalizeAddressList(config.hosts, defaultPort);
              const primaryAddress = parseHostPort(
                  normalizedHosts[0] || toAddress(config.host || 'localhost', Number(config.port || defaultPort), defaultPort),
                  defaultPort
              );
              const primaryHost = primaryAddress?.host || String(config.host || 'localhost');
              const primaryPort = primaryAddress?.port || Number(config.port || defaultPort);
              const mysqlReplicaHosts = (configType === 'mysql' || configType === 'mariadb' || configType === 'diros' || configType === 'sphinx') ? normalizedHosts.slice(1) : [];
              const mongoHosts = configType === 'mongodb' ? normalizedHosts.slice(1) : [];
              const mysqlIsReplica = String(config.topology || '').toLowerCase() === 'replica' || mysqlReplicaHosts.length > 0;
              const mongoIsReplica = String(config.topology || '').toLowerCase() === 'replica' || mongoHosts.length > 0 || !!config.replicaSet;
              form.setFieldsValue({
                  type: configType,
                  name: initialValues.name,
                  host: primaryHost,
                  port: primaryPort,
                  user: config.user,
                  password: config.password,
                  database: config.database,
                  uri: config.uri || '',
                  includeDatabases: initialValues.includeDatabases,
                  includeRedisDatabases: initialValues.includeRedisDatabases,
                  useSSH: config.useSSH,
                  sshHost: config.ssh?.host,
                  sshPort: config.ssh?.port,
                  sshUser: config.ssh?.user,
                  sshPassword: config.ssh?.password,
                  sshKeyPath: config.ssh?.keyPath,
                  driver: config.driver,
                  dsn: config.dsn,
                  timeout: config.timeout || 30,
                  mysqlTopology: mysqlIsReplica ? 'replica' : 'single',
                  mysqlReplicaHosts: mysqlReplicaHosts,
                  mysqlReplicaUser: config.mysqlReplicaUser || '',
                  mysqlReplicaPassword: config.mysqlReplicaPassword || '',
                  mongoTopology: mongoIsReplica ? 'replica' : 'single',
                  mongoHosts: mongoHosts,
                  mongoSrv: !!config.mongoSrv,
                  mongoReplicaSet: config.replicaSet || '',
                  mongoAuthSource: config.authSource || '',
                  mongoReadPreference: config.readPreference || 'primary',
                  mongoAuthMechanism: config.mongoAuthMechanism || '',
                  savePassword: config.savePassword !== false,
                  mongoReplicaUser: config.mongoReplicaUser || '',
                  mongoReplicaPassword: config.mongoReplicaPassword || ''
              });
              setUseSSH(config.useSSH || false);
              setDbType(configType);
              // 如果是 Redis 编辑模式，设置已保存的 Redis 数据库列表
              if (configType === 'redis') {
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
      const unavailableReason = await resolveDriverUnavailableReason(values.type);
      if (unavailableReason) {
          message.warning(unavailableReason);
          promptInstallDriver(values.type, unavailableReason);
          return;
      }
      setLoading(true);

      const config = await buildConfig(values, true);
      const displayHost = String((config as any).host || values.host || '').trim();

      const isRedisType = values.type === 'redis';
      const newConn = {
        id: initialValues ? initialValues.id : Date.now().toString(),
        name: values.name || (isFileDatabaseType(values.type) ? (values.type === 'duckdb' ? 'DuckDB DB' : 'SQLite DB') : (values.type === 'redis' ? `Redis ${displayHost}` : displayHost)),
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

  const buildTestFailureMessage = (reason: unknown, fallback: string) => {
      const text = String(reason ?? '').trim();
      const normalized = text && text !== 'undefined' && text !== 'null' ? text : fallback;
      return `测试失败: ${normalized}`;
  };

  const handleTest = async () => {
      if (testInFlightRef.current) return;
      testInFlightRef.current = true;
      try {
          const values = await form.validateFields();
          const unavailableReason = await resolveDriverUnavailableReason(values.type);
          if (unavailableReason) {
              const failMessage = buildTestFailureMessage(unavailableReason, '驱动未安装启用');
              setTestResult({ type: 'error', message: failMessage });
              promptInstallDriver(values.type, unavailableReason);
              return;
          }
          setLoading(true);
          setTestResult(null);
          const config = await buildConfig(values, false);

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
              const failMessage = buildTestFailureMessage(
                  res?.message,
                  '连接被拒绝或参数无效，请检查后重试'
              );
              setTestResult({ type: 'error', message: failMessage });
          }
      } catch (e: unknown) {
          if (e && typeof e === 'object' && 'errorFields' in e) {
              const failMessage = '测试失败: 请先完善必填项后再测试连接';
              setTestResult({ type: 'error', message: failMessage });
              return;
          }
          const reason = e instanceof Error
              ? e.message
              : (typeof e === 'string' ? e : '未知异常');
          const failMessage = buildTestFailureMessage(reason, '未知异常');
          setTestResult({ type: 'error', message: failMessage });
      } finally {
          testInFlightRef.current = false;
          setLoading(false);
      }
  };

  const handleDiscoverMongoMembers = async () => {
      if (discoveringMembers || dbType !== 'mongodb') {
          return;
      }
      try {
          const values = await form.validateFields();
          setDiscoveringMembers(true);
          const config = await buildConfig(values, false);
          const result = await MongoDiscoverMembers(config as any);
          if (!result.success) {
              message.error(result.message || '成员发现失败');
              return;
          }
          const data = (result.data as Record<string, any>) || {};
          const membersRaw = Array.isArray(data.members) ? data.members : [];
          const members: MongoMemberInfo[] = membersRaw
              .map((item: any) => ({
                  host: String(item.host || '').trim(),
                  role: String(item.role || item.state || 'UNKNOWN').trim(),
                  state: String(item.state || item.role || 'UNKNOWN').trim(),
                  stateCode: Number(item.stateCode || 0),
                  healthy: !!item.healthy,
                  isSelf: !!item.isSelf,
              }))
              .filter((item: MongoMemberInfo) => !!item.host);
          setMongoMembers(members);
          if (!form.getFieldValue('mongoReplicaSet') && data.replicaSet) {
              form.setFieldValue('mongoReplicaSet', String(data.replicaSet));
          }
          message.success(result.message || `发现 ${members.length} 个成员`);
      } catch (error: any) {
          message.error(error?.message || '成员发现失败');
      } finally {
          setDiscoveringMembers(false);
      }
  };

  const buildConfig = async (values: any, forPersist: boolean) => {
      const mergedValues = { ...values };
      const parsedUriValues = parseUriToValues(mergedValues.uri, mergedValues.type);
      const isEmptyField = (value: unknown) => (
          value === undefined
          || value === null
          || value === ''
          || value === 0
          || (Array.isArray(value) && value.length === 0)
      );
      if (parsedUriValues) {
          Object.entries(parsedUriValues).forEach(([key, value]) => {
              if (isEmptyField((mergedValues as any)[key])) {
                  (mergedValues as any)[key] = value;
              }
          });
      }

      const type = String(mergedValues.type || '').toLowerCase();
      const defaultPort = getDefaultPortByType(type);
      const parsedPrimary = parseHostPort(
          toAddress(mergedValues.host || 'localhost', Number(mergedValues.port || defaultPort), defaultPort),
          defaultPort
      );
      const primaryHost = parsedPrimary?.host || 'localhost';
      const primaryPort = parsedPrimary?.port || defaultPort;

      let hosts: string[] = [];
      let topology: 'single' | 'replica' | undefined;
      let replicaSet = '';
      let authSource = '';
      let readPreference = '';
      let mysqlReplicaUser = '';
      let mysqlReplicaPassword = '';
      let mongoSrvEnabled = false;
      let mongoAuthMechanism = '';
      let mongoReplicaUser = '';
      let mongoReplicaPassword = '';
      const savePassword = type === 'mongodb'
          ? mergedValues.savePassword !== false
          : true;

      if (type === 'mysql' || type === 'mariadb' || type === 'diros' || type === 'sphinx') {
          const replicas = mergedValues.mysqlTopology === 'replica'
              ? normalizeAddressList(mergedValues.mysqlReplicaHosts, defaultPort)
              : [];
          const allHosts = normalizeAddressList([`${primaryHost}:${primaryPort}`, ...replicas], defaultPort);
          if (mergedValues.mysqlTopology === 'replica' || allHosts.length > 1) {
              hosts = allHosts;
              topology = 'replica';
              mysqlReplicaUser = String(mergedValues.mysqlReplicaUser || '').trim();
              mysqlReplicaPassword = String(mergedValues.mysqlReplicaPassword || '');
          } else {
              topology = 'single';
          }
      }

      if (type === 'mongodb') {
          mongoSrvEnabled = !!mergedValues.mongoSrv;
          const extraHosts = mergedValues.mongoTopology === 'replica'
              ? (mongoSrvEnabled
                  ? normalizeMongoSrvHostList(mergedValues.mongoHosts, defaultPort)
                  : normalizeAddressList(mergedValues.mongoHosts, defaultPort))
              : [];
          const primarySeed = mongoSrvEnabled ? primaryHost : `${primaryHost}:${primaryPort}`;
          const allHosts = mongoSrvEnabled
              ? normalizeMongoSrvHostList([primarySeed, ...extraHosts], defaultPort)
              : normalizeAddressList([primarySeed, ...extraHosts], defaultPort);
          if (mergedValues.mongoTopology === 'replica' || allHosts.length > 1 || mergedValues.mongoReplicaSet) {
              hosts = allHosts;
              topology = 'replica';
              mongoReplicaUser = String(mergedValues.mongoReplicaUser || '').trim();
              mongoReplicaPassword = String(mergedValues.mongoReplicaPassword || '');
          } else {
              topology = 'single';
          }
          replicaSet = String(mergedValues.mongoReplicaSet || '').trim();
          authSource = String(mergedValues.mongoAuthSource || mergedValues.database || 'admin').trim();
          readPreference = String(mergedValues.mongoReadPreference || 'primary').trim();
          mongoAuthMechanism = String(mergedValues.mongoAuthMechanism || '').trim().toUpperCase();
      }

      const sshConfig = mergedValues.useSSH ? {
          host: mergedValues.sshHost,
          port: Number(mergedValues.sshPort),
          user: mergedValues.sshUser,
          password: mergedValues.sshPassword || "",
          keyPath: mergedValues.sshKeyPath || ""
      } : { host: "", port: 22, user: "", password: "", keyPath: "" };

      const keepPassword = !forPersist || savePassword;

      return {
          type: mergedValues.type,
          host: primaryHost,
          port: Number(primaryPort || 0),
          user: mergedValues.user || "",
          password: keepPassword ? (mergedValues.password || "") : "",
          savePassword: savePassword,
          database: mergedValues.database || "",
          useSSH: !!mergedValues.useSSH,
          ssh: sshConfig,
          driver: mergedValues.driver,
          dsn: mergedValues.dsn,
          timeout: Number(mergedValues.timeout || 30),
          uri: String(mergedValues.uri || '').trim(),
          hosts: hosts,
          topology: topology,
          mysqlReplicaUser: mysqlReplicaUser,
          mysqlReplicaPassword: keepPassword ? mysqlReplicaPassword : "",
          replicaSet: replicaSet,
          authSource: authSource,
          readPreference: readPreference,
          mongoSrv: mongoSrvEnabled,
          mongoAuthMechanism: mongoAuthMechanism,
          mongoReplicaUser: mongoReplicaUser,
          mongoReplicaPassword: keepPassword ? mongoReplicaPassword : "",
      };
  };

  const handleTypeSelect = async (type: string) => {
      const unavailableReason = await resolveDriverUnavailableReason(type);
      if (unavailableReason) {
          const normalized = normalizeDriverType(type);
          const driverName = driverStatusMap[normalized]?.name || type;
          setTypeSelectWarning({ driverName, reason: unavailableReason });
          return;
      }
      setTypeSelectWarning(null);
      setDbType(type);
      form.setFieldsValue({ type: type });

      const defaultPort = getDefaultPortByType(type);
      if (!isFileDatabaseType(type) && type !== 'custom') {
          form.setFieldsValue({
              port: defaultPort,
              mysqlTopology: 'single',
              mongoTopology: 'single',
              mongoSrv: false,
              mongoReadPreference: 'primary',
              mongoReplicaSet: '',
              mongoAuthSource: '',
              mongoAuthMechanism: '',
              savePassword: true,
              mysqlReplicaHosts: [],
              mongoHosts: [],
              mysqlReplicaUser: '',
              mysqlReplicaPassword: '',
              mongoReplicaUser: '',
              mongoReplicaPassword: '',
          });
      }

      setMongoMembers([]);
      setStep(2);
  };

  const isFileDb = isFileDatabaseType(dbType);
  const isCustom = dbType === 'custom';
  const isRedis = dbType === 'redis';
  const currentDriverType = normalizeDriverType(dbType);
  const currentDriverSnapshot = driverStatusMap[currentDriverType];
  const currentDriverUnavailableReason = currentDriverType !== 'custom'
      && currentDriverSnapshot
      && !currentDriverSnapshot.connectable
      ? (currentDriverSnapshot.message || `${currentDriverSnapshot.name || dbType} 驱动未安装启用`)
      : '';
  const driverStatusChecking = currentDriverType !== 'custom' && !driverStatusLoaded && step === 2;

  const dbTypeGroups = [
      { label: '关系型数据库', items: [
          { key: 'mysql', name: 'MySQL', icon: <ConsoleSqlOutlined style={{ fontSize: 24, color: '#00758F' }} /> },
          { key: 'mariadb', name: 'MariaDB', icon: <ConsoleSqlOutlined style={{ fontSize: 24, color: '#003545' }} /> },
          { key: 'diros', name: 'Diros', icon: <ConsoleSqlOutlined style={{ fontSize: 24, color: '#0050b3' }} /> },
          { key: 'sphinx', name: 'Sphinx', icon: <ConsoleSqlOutlined style={{ fontSize: 24, color: '#2F5D62' }} /> },
          { key: 'postgres', name: 'PostgreSQL', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#336791' }} /> },
          { key: 'sqlserver', name: 'SQL Server', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#CC2927' }} /> },
          { key: 'sqlite', name: 'SQLite', icon: <FileTextOutlined style={{ fontSize: 24, color: '#003B57' }} /> },
          { key: 'duckdb', name: 'DuckDB', icon: <FileTextOutlined style={{ fontSize: 24, color: '#f59e0b' }} /> },
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
      { label: '时序数据库', items: [
          { key: 'tdengine', name: 'TDengine', icon: <DatabaseOutlined style={{ fontSize: 24, color: '#2F54EB' }} /> },
      ]},
      { label: '其他', items: [
          { key: 'custom', name: 'Custom (自定义)', icon: <AppstoreAddOutlined style={{ fontSize: 24, color: '#595959' }} /> },
      ]},
  ];

  const dbTypes = dbTypeGroups.flatMap(g => g.items);

  const renderStep1 = () => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {typeSelectWarning && (
              <Alert
                  type="warning"
                  showIcon
                  closable
                  message={`${typeSelectWarning.driverName} 驱动未启用`}
                  description={(
                      <Space size={8}>
                          <span>{typeSelectWarning.reason}</span>
                          <Button type="link" size="small" onClick={() => onOpenDriverManager?.()}>
                              去驱动管理安装
                          </Button>
                      </Space>
                  )}
                  onClose={() => setTypeSelectWarning(null)}
              />
          )}
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
                              onClick={() => { void handleTypeSelect(item.key); }}
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
      </div>
  );

  const renderStep2 = () => (
      <Form 
        form={form} 
        layout="vertical" 
        initialValues={{
            type: 'mysql',
            host: 'localhost',
            port: 3306,
            user: 'root',
            useSSH: false,
            sshPort: 22,
            timeout: 30,
            uri: '',
            mysqlTopology: 'single',
            mongoTopology: 'single',
            mongoSrv: false,
            mongoReadPreference: 'primary',
            mongoAuthMechanism: '',
            savePassword: true,
            mysqlReplicaHosts: [],
            mongoHosts: [],
            mysqlReplicaUser: '',
            mysqlReplicaPassword: '',
            mongoReplicaUser: '',
            mongoReplicaPassword: '',
        }}
        onValuesChange={(changed) => {
            if (testResult) {
                setTestResult(null); // Clear result on change
                setTestErrorLogOpen(false);
            }
            if (changed.uri !== undefined || changed.type !== undefined) {
                setUriFeedback(null);
            }
            if (changed.useSSH !== undefined) setUseSSH(changed.useSSH);
            // Type change handled by step 1, but keep sync if select changes (hidden now)
            if (changed.type !== undefined) setDbType(changed.type);
            if (
                changed.type !== undefined
                || changed.host !== undefined
                || changed.port !== undefined
                || changed.mongoHosts !== undefined
                || changed.mongoTopology !== undefined
                || changed.mongoSrv !== undefined
            ) {
                setMongoMembers([]);
            }
        }}
      >
        {/* Hidden Type Field to keep form value synced */}
        <Form.Item name="type" hidden><Input /></Form.Item>

        <Form.Item name="name" label="连接名称">
            <Input placeholder="例如：本地测试库" />
        </Form.Item>
        <Form.Item
            name="uri"
            label="连接 URI（可复制粘贴）"
            help="支持从参数生成、复制到剪贴板，或粘贴后一键解析回填参数"
        >
            <Input.TextArea rows={2} placeholder={getUriPlaceholder()} />
        </Form.Item>
        <Space size={8} style={{ marginBottom: 12 }}>
            <Button onClick={handleGenerateURI}>生成 URI</Button>
            <Button onClick={handleParseURI}>从 URI 解析</Button>
            <Button onClick={handleCopyURI}>复制 URI</Button>
        </Space>
        {uriFeedback && (
            <Alert
                showIcon
                closable
                type={uriFeedback.type}
                message={uriFeedback.message}
                onClose={() => setUriFeedback(null)}
                style={{ marginBottom: 12 }}
            />
        )}
        {currentDriverUnavailableReason && (
            <Alert
                showIcon
                type="warning"
                style={{ marginBottom: 12 }}
                message="当前数据源驱动未启用"
                description={(
                    <Space size={8}>
                        <span>{currentDriverUnavailableReason}</span>
                        <Button type="link" size="small" onClick={() => onOpenDriverManager?.()}>
                            去驱动管理安装
                        </Button>
                    </Space>
                )}
            />
        )}
        
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
            <Form.Item
                name="host"
                label={isFileDb ? "文件路径 (绝对路径)" : "主机地址 (Host)"}
                rules={[createUriAwareRequiredRule('请输入地址/路径')]}
                style={{ flex: 1 }}
            >
              <Input
                placeholder={isFileDb ? (dbType === 'duckdb' ? "/path/to/db.duckdb" : "/path/to/db.sqlite") : "localhost"}
                onDoubleClick={requestTest}
              />
            </Form.Item>
            {!isFileDb && (
            <Form.Item
                name="port"
                label="端口 (Port)"
                rules={[createUriAwareRequiredRule('请输入端口号', (value) => Number(value) > 0)]}
                style={{ width: 100 }}
            >
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            )}
        </div>

        {(dbType === 'mysql' || dbType === 'mariadb' || dbType === 'diros' || dbType === 'sphinx') && (
        <>
            <Form.Item name="mysqlTopology" label="连接模式">
                <Select
                    options={[
                        { value: 'single', label: '单机模式' },
                        { value: 'replica', label: '主从模式（优先主库，可切换从库）' },
                    ]}
                />
            </Form.Item>
            {mysqlTopology === 'replica' && (
            <>
                <Form.Item
                    name="mysqlReplicaHosts"
                    label="从库地址列表"
                    help="可输入多个从库地址，格式：host:port（回车确认）"
                >
                    <Select mode="tags" placeholder="例如：10.10.0.12:3306、10.10.0.13:3306" tokenSeparators={[',', ';', ' ']} />
                </Form.Item>
                <div style={{ display: 'flex', gap: 16 }}>
                    <Form.Item name="mysqlReplicaUser" label="从库用户名（可选）" style={{ flex: 1 }}>
                        <Input placeholder="留空沿用主库用户名" />
                    </Form.Item>
                    <Form.Item name="mysqlReplicaPassword" label="从库密码（可选）" style={{ flex: 1 }}>
                        <Input.Password placeholder="留空沿用主库密码" />
                    </Form.Item>
                </div>
            </>
            )}
        </>
        )}

        {dbType === 'mongodb' && (
        <>
            <Form.Item name="mongoSrv" valuePropName="checked" style={{ marginBottom: 12 }}>
                <Checkbox>使用 SRV 记录（mongodb+srv）</Checkbox>
            </Form.Item>
            <Form.Item name="mongoTopology" label="连接模式">
                <Select
                    options={[
                        { value: 'single', label: '单机模式' },
                        { value: 'replica', label: '主从/副本集模式' },
                    ]}
                />
            </Form.Item>
            {mongoSrv && useSSH && (
                <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="SRV 记录模式暂不支持 SSH 隧道，请关闭其中一项后再测试连接"
                />
            )}
            {mongoTopology === 'replica' && (
            <>
                {!mongoSrv && (
                <Form.Item
                    name="mongoHosts"
                    label="附加节点地址"
                    help="主节点使用上方主机地址；这里填写其余节点，格式：host:port"
                >
                    <Select mode="tags" placeholder="例如：10.10.0.22:27017、10.10.0.23:27017" tokenSeparators={[',', ';', ' ']} />
                </Form.Item>
                )}
                {mongoSrv && (
                <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="SRV 模式将通过 DNS 自动发现成员，无需手动填写附加节点地址"
                />
                )}
                <Form.Item name="mongoReplicaSet" label="Replica Set 名称">
                    <Input placeholder="例如：rs0" />
                </Form.Item>
                <div style={{ display: 'flex', gap: 16 }}>
                    <Form.Item name="mongoReplicaUser" label="从库用户名（可选）" style={{ flex: 1 }}>
                        <Input placeholder="留空沿用主库用户名" />
                    </Form.Item>
                    <Form.Item name="mongoReplicaPassword" label="从库密码（可选）" style={{ flex: 1 }}>
                        <Input.Password placeholder="留空沿用主库密码" />
                    </Form.Item>
                </div>
                <Space size={8} style={{ marginBottom: 12 }}>
                    <Button onClick={handleDiscoverMongoMembers} loading={discoveringMembers}>发现成员</Button>
                    <Text type="secondary">发现后可校验当前副本集状态</Text>
                </Space>
                {mongoMembers.length > 0 && (
                    <Table
                        size="small"
                        pagination={false}
                        rowKey={(record) => `${record.host}-${record.state}`}
                        dataSource={mongoMembers}
                        style={{ marginBottom: 12 }}
                        columns={[
                            {
                                title: '成员',
                                dataIndex: 'host',
                                width: '48%',
                                render: (value: string, record: MongoMemberInfo) => (
                                    <span>
                                        {value}
                                        {record.isSelf ? <Tag color="processing" style={{ marginLeft: 8 }}>当前</Tag> : null}
                                    </span>
                                ),
                            },
                            {
                                title: '状态',
                                dataIndex: 'state',
                                width: '32%',
                                render: (value: string) => {
                                    const state = String(value || '').toUpperCase();
                                    let color: string = 'default';
                                    if (state === 'PRIMARY') color = 'success';
                                    else if (state === 'SECONDARY' || state === 'PASSIVE') color = 'blue';
                                    else if (state === 'ARBITER') color = 'purple';
                                    else if (state === 'DOWN' || state === 'REMOVED' || state === 'UNKNOWN') color = 'error';
                                    return <Tag color={color}>{state || 'UNKNOWN'}</Tag>;
                                },
                            },
                            {
                                title: '健康',
                                dataIndex: 'healthy',
                                width: '20%',
                                render: (value: boolean) => (
                                    <Tag color={value ? 'success' : 'error'}>{value ? '正常' : '异常'}</Tag>
                                ),
                            },
                        ]}
                    />
                )}
            </>
            )}
            <Form.Item name="mongoAuthSource" label="认证库 (authSource)">
                <Input placeholder="默认使用 database 或 admin" />
            </Form.Item>
            <Form.Item name="mongoReadPreference" label="读偏好 (readPreference)">
                <Select
                    options={[
                        { value: 'primary', label: 'primary' },
                        { value: 'primaryPreferred', label: 'primaryPreferred' },
                        { value: 'secondary', label: 'secondary' },
                        { value: 'secondaryPreferred', label: 'secondaryPreferred' },
                        { value: 'nearest', label: 'nearest' },
                    ]}
                />
            </Form.Item>
        </>
        )}

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
        {!isFileDb && !isRedis && (
        <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item
                name="user"
                label="用户名"
                rules={[createUriAwareRequiredRule('请输入用户名')]}
                style={{ flex: 1 }}
            >
              <Input />
            </Form.Item>
            <Form.Item name="password" label="密码" style={{ flex: 1 }}>
              <Input.Password />
            </Form.Item>
            {dbType === 'mongodb' && (
            <Form.Item name="mongoAuthMechanism" label="验证方式" style={{ width: 160 }}>
                <Select
                    allowClear
                    placeholder="自动协商"
                    options={[
                        { value: 'SCRAM-SHA-1', label: 'SCRAM-SHA-1' },
                        { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
                        { value: 'MONGODB-AWS', label: 'MONGODB-AWS' },
                    ]}
                />
            </Form.Item>
            )}
        </div>
        )}

        {dbType === 'mongodb' && (
        <Form.Item name="savePassword" valuePropName="checked" style={{ marginTop: -6 }}>
            <Checkbox>保存密码</Checkbox>
        </Form.Item>
        )}

        {!isFileDb && !isRedis && (
        <Form.Item name="includeDatabases" label="显示数据库 (留空显示全部)" help="连接测试成功后可选择">
            <Select mode="multiple" placeholder="选择显示的数据库" allowClear>
                {dbList.map(db => <Select.Option key={db} value={db}>{db}</Select.Option>)}
            </Select>
        </Form.Item>
        )}

        {!isFileDb && (
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
        
      </Form>
  );

  const getFooter = () => {
      if (step === 1) {
          return [
             <Button key="cancel" onClick={onClose}>取消</Button>
          ];
      }
      const isTestSuccess = testResult?.type === 'success';
      const hasTestError = !!testResult && !isTestSuccess;
      const operationBlocked = !!currentDriverUnavailableReason || driverStatusChecking;
      return (
          <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                  {!initialValues && <Button key="back" onClick={() => setStep(1)}>上一步</Button>}
                  {testResult ? (
                      <span
                          style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              height: 24,
                              padding: '0 10px',
                              borderRadius: 999,
                              border: isTestSuccess ? '1px solid rgba(82, 196, 26, 0.35)' : '1px solid rgba(255, 77, 79, 0.35)',
                              background: isTestSuccess ? 'rgba(82, 196, 26, 0.10)' : 'rgba(255, 77, 79, 0.10)',
                              color: isTestSuccess ? '#389e0d' : '#cf1322',
                              fontSize: 12,
                              lineHeight: '22px',
                              whiteSpace: 'nowrap',
                              boxSizing: 'border-box',
                          }}
                      >
                          {isTestSuccess ? <CheckCircleFilled /> : <CloseCircleFilled />}
                          <span>{isTestSuccess ? '连接成功' : '连接失败'}</span>
                      </span>
                  ) : null}
                  {hasTestError && (
                      <Button
                          size="small"
                          icon={<FileTextOutlined />}
                          style={{
                              height: 24,
                              borderRadius: 999,
                              padding: '0 10px',
                              borderColor: '#ffccc7',
                              background: '#fff2f0',
                              color: '#cf1322',
                          }}
                          onClick={() => setTestErrorLogOpen(true)}
                      >
                          查看原因
                      </Button>
                  )}
              </div>
              <Space size={8} style={{ flexShrink: 0 }}>
                  <Button key="test" loading={loading} disabled={operationBlocked} onClick={requestTest}>测试连接</Button>
                  <Button key="cancel" onClick={onClose}>取消</Button>
                  <Button key="submit" type="primary" loading={loading} disabled={operationBlocked} onClick={handleOk}>保存</Button>
              </Space>
          </div>
      );
  };

  const getTitle = () => {
      if (step === 1) return "选择数据源类型";
      const typeName = dbTypes.find(t => t.key === dbType)?.name || dbType;
      return initialValues ? "编辑连接" : `新建 ${typeName} 连接`;
  };

  const modalBodyStyle = step === 1
      ? { padding: '16px 24px', overflow: 'hidden' as const }
      : {
          padding: '16px 24px',
          overflowY: 'auto' as const,
          overflowX: 'hidden' as const,
      };

  return (
    <>
      <Modal
          title={getTitle()}
          open={open}
          onCancel={onClose}
          footer={getFooter()}
          centered
          wrapClassName="connection-modal-wrap"
          width={step === 1 ? 650 : 600}
          zIndex={10001}
          destroyOnHidden
          maskClosable={false}
          styles={{ body: modalBodyStyle }}
      >
        {step === 1 ? renderStep1() : renderStep2()}
      </Modal>
      <Modal
          title="测试连接失败原因"
          open={testErrorLogOpen}
          onCancel={() => setTestErrorLogOpen(false)}
          centered
          width={760}
          zIndex={10002}
          destroyOnHidden
          footer={[
              <Button key="close" onClick={() => setTestErrorLogOpen(false)}>关闭</Button>,
          ]}
      >
          <pre
              style={{
                  margin: 0,
                  maxHeight: '50vh',
                  overflowY: 'auto',
                  padding: 12,
                  borderRadius: 6,
                  background: '#fff2f0',
                  border: '1px solid #ffccc7',
                  color: '#a8071a',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  lineHeight: '20px',
                  fontSize: 13,
              }}
          >
              {String(testResult?.message || '暂无失败日志')}
          </pre>
      </Modal>
    </>
  );
};

export default ConnectionModal;
