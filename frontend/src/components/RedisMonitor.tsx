import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Card, Row, Col, Statistic, Button, Tag, Typography, Spin } from 'antd';
import { AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid, Legend, LineChart, Line } from 'recharts';
import {
  DesktopOutlined,
  DashboardOutlined,
  ApiOutlined,
  HddOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined
} from '@ant-design/icons';
import { useStore } from '../store';
import { SavedConnection } from '../types';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { t, type I18nParams } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { RedisGetServerInfo } from '../../wailsjs/go/app/App';

const { Title, Text } = Typography;

interface RedisMonitorProps {
  connectionId: string;
  redisDB: number;
  isActive?: boolean;
}

// Data point for charts
interface MetricPoint {
  timestamp: number;
  qps: number;
  memory: number; // in MB
  memory_rss: number; // in MB
  clients: number;
  cpuSys: number;
  cpuUser: number;
  hitRate: number;
  keys: number;
}

const MAX_HISTORY_POINTS = 60; // Keep up to 60 data points
const POLL_INTERVAL_MS = 2000;
const formatMetricTimestamp = (timestamp: unknown) => {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return '';

  return new Date(value).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const RedisMonitor: React.FC<RedisMonitorProps> = ({ connectionId, redisDB, isActive = true }) => {
  const connections = useStore(state => state.connections);
  const theme = useStore(state => state.theme);
  const darkMode = theme === 'dark';
  const i18n = useOptionalI18n();
  const i18nLanguage = i18n?.language;
  const tr = useCallback(
    (key: string, params?: I18nParams) => t(key, params, i18nLanguage),
    [i18nLanguage],
  );

  const [isRunning, setIsRunning] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [history, setHistory] = useState<MetricPoint[]>([]);
  const [currentInfo, setCurrentInfo] = useState<Record<string, string>>({});
  
  // Ref to track if component is mounted to prevent state updates after unmount
  const mountedRef = useRef(false);
  const monitorActiveRef = useRef(false);
  const autoRefreshEnabledRef = useRef(false);
  const pollingGenerationRef = useRef(0);
  const inFlightGenerationsRef = useRef(new Set<number>());
  const nextPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestMetricsRef = useRef<(generation: number) => Promise<void>>(async () => undefined);
  const connection = connections.find((c: SavedConnection) => c.id === connectionId);
  const formatFetchError = useCallback((detail?: unknown) => tr('redis_monitor.message.fetch_failed', {
    detail: String(detail || tr('common.unknown')),
  }), [tr]);

  const fetchMetrics = useCallback(async (generation: number) => {
    if (!connection) return;

    try {
      const config = buildRpcConnectionConfig(connection.config, { redisDB });
      const res = await RedisGetServerInfo(config);
      
      if (
        !mountedRef.current
        || !monitorActiveRef.current
        || generation !== pollingGenerationRef.current
      ) return;

      if (!res.success) {
        setError(formatFetchError(res.message));
        return;
      }

      setError(null);
      const infoMap = res.data as Record<string, string>;
      setCurrentInfo(infoMap);

      const timestamp = Date.now();
      
      // Parse values
      const qps = parseInt(infoMap['instantaneous_ops_per_sec'] || '0', 10);
      const memBytes = parseInt(infoMap['used_memory'] || '0', 10);
      const memRssBytes = parseInt(infoMap['used_memory_rss'] || '0', 10);
      const clients = parseInt(infoMap['connected_clients'] || '0', 10);
      const cpuSys = parseFloat(infoMap['used_cpu_sys'] || '0');
      const cpuUser = parseFloat(infoMap['used_cpu_user'] || '0');
      
      const hits = parseInt(infoMap['keyspace_hits'] || '0', 10);
      const misses = parseInt(infoMap['keyspace_misses'] || '0', 10);
      const hitRate = (hits + misses) > 0 ? (hits / (hits + misses)) * 100 : 0;
      
      let keys = 0;
      Object.keys(infoMap).forEach(k => {
        if (k.startsWith('db')) {
          const m = infoMap[k].match(/keys=(\d+)/);
          if (m) keys += parseInt(m[1], 10);
        }
      });

      const point: MetricPoint = {
        timestamp,
        qps,
        memory: parseFloat((memBytes / 1024 / 1024).toFixed(2)),
        memory_rss: parseFloat((memRssBytes / 1024 / 1024).toFixed(2)),
        clients,
        cpuSys: parseFloat(cpuSys.toFixed(2)),
        cpuUser: parseFloat(cpuUser.toFixed(2)),
        hitRate: parseFloat(hitRate.toFixed(2)),
        keys
      };

      setHistory(prev => {
        const next = [...prev, point];
        if (next.length > MAX_HISTORY_POINTS) {
          return next.slice(next.length - MAX_HISTORY_POINTS);
        }
        return next;
      });

      setLoading(false);

    } catch (err: any) {
      if (
        mountedRef.current
        && monitorActiveRef.current
        && generation === pollingGenerationRef.current
      ) {
        setError(formatFetchError(err?.message || err));
        setLoading(false);
      }
    }
  }, [connection, formatFetchError, redisDB]);

  const clearNextPollTimer = useCallback(() => {
    if (nextPollTimerRef.current === null) return;
    clearTimeout(nextPollTimerRef.current);
    nextPollTimerRef.current = null;
  }, []);

  const requestMetrics = useCallback(async (generation: number) => {
    if (
      !monitorActiveRef.current
      || generation !== pollingGenerationRef.current
      || inFlightGenerationsRef.current.has(generation)
    ) return;

    clearNextPollTimer();
    inFlightGenerationsRef.current.add(generation);
    try {
      await fetchMetrics(generation);
    } finally {
      inFlightGenerationsRef.current.delete(generation);
      if (
        mountedRef.current
        && monitorActiveRef.current
        && autoRefreshEnabledRef.current
        && generation === pollingGenerationRef.current
      ) {
        nextPollTimerRef.current = setTimeout(() => {
          nextPollTimerRef.current = null;
          void requestMetricsRef.current(generation);
        }, POLL_INTERVAL_MS);
      }
    }
  }, [clearNextPollTimer, fetchMetrics]);
  requestMetricsRef.current = requestMetrics;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      monitorActiveRef.current = false;
      autoRefreshEnabledRef.current = false;
      pollingGenerationRef.current += 1;
      inFlightGenerationsRef.current.clear();
      clearNextPollTimer();
    };
  }, [clearNextPollTimer]);

  useEffect(() => {
    clearNextPollTimer();
    const generation = ++pollingGenerationRef.current;
    const monitorActive = isActive && Boolean(connection);
    monitorActiveRef.current = monitorActive;
    autoRefreshEnabledRef.current = monitorActive && isRunning;
    if (autoRefreshEnabledRef.current) void requestMetricsRef.current(generation);

    return () => {
      if (pollingGenerationRef.current !== generation) return;
      pollingGenerationRef.current += 1;
      monitorActiveRef.current = false;
      autoRefreshEnabledRef.current = false;
      inFlightGenerationsRef.current.delete(generation);
      clearNextPollTimer();
    };
  }, [clearNextPollTimer, connection, isActive, isRunning, requestMetrics]);

  if (!connection) {
    return <div style={{ padding: 20 }}>{tr('redis_monitor.state.connection_not_found')}</div>;
  }

  // Determine styles for charts based on theme
  const chartTextColor = darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)';
  const chartGridColor = darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
  const cardBgColor = darkMode ? '#1f1f1f' : '#ffffff';
  
  const getFormatMemoryString = (bytes: string) => {
    const val = parseInt(bytes || '0', 10);
    if (val > 1024*1024*1024) return (val/1024/1024/1024).toFixed(2) + ' GB';
    if (val > 1024*1024) return (val/1024/1024).toFixed(2) + ' MB';
    if (val > 1024) return (val/1024).toFixed(2) + ' KB';
    return val + ' B';
  };

  const getUptimeString = (seconds: string) => {
    const d = parseInt(seconds || '0', 10);
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.floor(d/60)}m ${d%60}s`;
    if (d < 86400) return `${Math.floor(d/3600)}h ${Math.floor((d%3600)/60)}m`;
    return `${Math.floor(d/86400)}d ${Math.floor((d%86400)/3600)}h`;
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '16px 24px', backgroundColor: darkMode ? '#141414' : '#f0f2f5' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <Title level={3} style={{ margin: 0, fontWeight: 600 }}>
            <DashboardOutlined style={{ marginRight: 8, color: '#1677ff' }} />
            {tr('redis_monitor.title.instance')}
          </Title>
          <Text type="secondary">
            {connection.name} 
            {currentInfo.redis_version && ` •  Redis ${currentInfo.redis_version}`}
            {currentInfo.os && ` •  ${currentInfo.os}`}
          </Text>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {error && <Tag color="error" style={{ height: 32, lineHeight: '30px', fontSize: 13 }}>{error}</Tag>}
          {loading && !error && <Spin style={{ alignSelf: 'center', marginRight: 16 }} />}
          
          <Button 
            type={isRunning ? "default" : "primary"}
            icon={isRunning ? <PauseCircleOutlined /> : <PlayCircleOutlined />} 
            onClick={() => setIsRunning(!isRunning)}
          >
            {isRunning ? tr('redis_monitor.action.pause_refresh') : tr('redis_monitor.action.resume_refresh')}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => { void requestMetricsRef.current(pollingGenerationRef.current); }}
          >
            {tr('redis_monitor.action.refresh_now')}
          </Button>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Card bordered={false} style={{ background: cardBgColor, borderRadius: 8, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}>
            <Statistic 
              title={<span style={{ fontWeight: 500 }}><DesktopOutlined /> {tr('redis_monitor.metric.memory_used')}</span>}
              value={getFormatMemoryString(currentInfo.used_memory || '0')}
              valueStyle={{ color: '#eb2f96', fontWeight: 600 }}
              suffix={<Text type="secondary" style={{ fontSize: 13, marginLeft: 8 }}>{tr('redis_monitor.metric.memory_peak', { value: getFormatMemoryString(currentInfo.used_memory_peak || '0') })}</Text>}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card bordered={false} style={{ background: cardBgColor, borderRadius: 8, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}>
            <Statistic 
              title={<span style={{ fontWeight: 500 }}><ApiOutlined /> {tr('redis_monitor.metric.clients')}</span>}
              value={currentInfo.connected_clients || '0'}
              valueStyle={{ color: '#1677ff', fontWeight: 600 }}
              suffix={<Text type="secondary" style={{ fontSize: 13, marginLeft: 8 }}>{tr('redis_monitor.metric.blocked_clients', { value: currentInfo.blocked_clients || '0' })}</Text>}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card bordered={false} style={{ background: cardBgColor, borderRadius: 8, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}>
            <Statistic 
              title={<span style={{ fontWeight: 500 }}><HddOutlined /> {tr('redis_monitor.metric.ops')}</span>}
              value={currentInfo.instantaneous_ops_per_sec || '0'}
              valueStyle={{ color: '#52c41a', fontWeight: 600 }}
              suffix={<Text type="secondary" style={{ fontSize: 13, marginLeft: 8 }}>cmds/s</Text>}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card bordered={false} style={{ background: cardBgColor, borderRadius: 8, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}>
            <Statistic 
              title={<span style={{ fontWeight: 500 }}>{tr('redis_monitor.metric.uptime')}</span>}
              value={getUptimeString(currentInfo.uptime_in_seconds || '0')}
              valueStyle={{ color: '#fa8c16', fontWeight: 600 }}
              suffix={<Text type="secondary" style={{ fontSize: 13, marginLeft: 8 }}>{tr('redis_monitor.metric.days', { value: currentInfo.uptime_in_days || '0' })}</Text>}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card 
            bordered={false} 
            title={tr('redis_monitor.chart.qps')}
            style={{ background: cardBgColor, borderRadius: 8, height: 350, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}
            styles={{ body: { padding: '16px 16px 0 0', height: 290 } }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorQps" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#52c41a" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#52c41a" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={formatMetricTimestamp}
                  tick={{ fill: chartTextColor, fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={20}
                />
                <YAxis tick={{ fill: chartTextColor, fontSize: 12 }} axisLine={false} tickLine={false} />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: cardBgColor, border: `1px solid ${chartGridColor}`, borderRadius: 6 }}
                  itemStyle={{ fontWeight: 600 }}
                  labelFormatter={formatMetricTimestamp}
                />
                <Area type="monotone" dataKey="qps" name="QPS" stroke="#52c41a" strokeWidth={2} fillOpacity={1} fill="url(#colorQps)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        
        <Col span={12}>
          <Card 
            bordered={false} 
            title={tr('redis_monitor.chart.memory')}
            style={{ background: cardBgColor, borderRadius: 8, height: 350, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}
            styles={{ body: { padding: '16px 16px 0 0', height: 290 } }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={formatMetricTimestamp}
                  tick={{ fill: chartTextColor, fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={20}
                />
                <YAxis tick={{ fill: chartTextColor, fontSize: 12 }} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: cardBgColor, border: `1px solid ${chartGridColor}`, borderRadius: 6 }}
                  itemStyle={{ fontWeight: 600 }}
                  formatter={(value: any) => [`${value} MB`]}
                  labelFormatter={formatMetricTimestamp}
                />
                <Legend verticalAlign="top" height={36}/>
                <Line type="monotone" dataKey="memory" name={tr('redis_monitor.series.used_memory')} stroke="#eb2f96" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="memory_rss" name={tr('redis_monitor.series.rss_memory')} stroke="#722ed1" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card 
            bordered={false} 
            title={tr('redis_monitor.chart.cpu_usage')}
            style={{ background: cardBgColor, borderRadius: 8, height: 300, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}
            styles={{ body: { padding: '16px 16px 0 0', height: 240 } }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={formatMetricTimestamp}
                  tick={{ fill: chartTextColor, fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={20}
                />
                <YAxis tick={{ fill: chartTextColor, fontSize: 12 }} axisLine={false} tickLine={false} />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: cardBgColor, border: `1px solid ${chartGridColor}`, borderRadius: 6 }}
                  itemStyle={{ fontWeight: 600 }}
                  formatter={(value: any) => [`${value} s`]}
                  labelFormatter={formatMetricTimestamp}
                />
                <Legend verticalAlign="top" height={36}/>
                <Line type="monotone" dataKey="cpuSys" name={tr('redis_monitor.series.system')} stroke="#cf1322" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="cpuUser" name={tr('redis_monitor.series.user')} stroke="#1677ff" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        
        <Col span={12}>
          <Card 
            bordered={false} 
            title={tr('redis_monitor.chart.clients_keys')}
            style={{ background: cardBgColor, borderRadius: 8, height: 300, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)' }}
            styles={{ body: { padding: '16px 16px 0 0', height: 240 } }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={formatMetricTimestamp}
                  tick={{ fill: chartTextColor, fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={20}
                />
                <YAxis yAxisId="left" tick={{ fill: chartTextColor, fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="right" orientation="right" tick={{ fill: chartTextColor, fontSize: 12 }} axisLine={false} tickLine={false} />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: cardBgColor, border: `1px solid ${chartGridColor}`, borderRadius: 6 }}
                  itemStyle={{ fontWeight: 600 }}
                  labelFormatter={formatMetricTimestamp}
                />
                <Legend verticalAlign="top" height={36}/>
                <Line yAxisId="left" type="stepAfter" dataKey="clients" name={tr('redis_monitor.series.clients')} stroke="#1677ff" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line yAxisId="right" type="stepAfter" dataKey="keys" name={tr('redis_monitor.series.total_keys')} stroke="#fa8c16" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      <div style={{ marginTop: 24 }}>
        <Card bordered={false} title={tr('redis_monitor.server_details.title')} style={{ background: cardBgColor, borderRadius: 8 }}>
          <div style={{ columnCount: 3, columnGap: 40 }}>
            {['redis_version', 'os', 'arch_bits', 'multiplexing_api', 'gcc_version', 'run_id', 'tcp_port', 'uptime_in_days', 'hz', 'lru_clock', 'role', 'maxmemory_human', 'maxmemory_policy', 'mem_fragmentation_ratio', 'keyspace_hits', 'keyspace_misses', 'total_connections_received'].map(key => (
              currentInfo[key] ? (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, borderBottom: `1px dashed ${chartGridColor}` }}>
                  <Text type="secondary">{key}</Text>
                  <Text strong>{currentInfo[key]}</Text>
                </div>
              ) : null
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default RedisMonitor;
