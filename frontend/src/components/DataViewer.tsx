import React, { useEffect, useState, useCallback, useRef } from 'react';
import { message } from 'antd';
import { TabData, ColumnDefinition } from '../types';
import { useStore } from '../store';
import { DBQuery, DBGetColumns } from '../../wailsjs/go/app/App';
import DataGrid, { GONAVI_ROW_KEY } from './DataGrid';
import { buildOrderBySQL, buildWhereSQL, quoteQualifiedIdent, withSortBufferTuningSQL, type FilterCondition } from '../utils/sql';

const DataViewer: React.FC<{ tab: TabData }> = ({ tab }) => {
  const [data, setData] = useState<any[]>([]);
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const connections = useStore(state => state.connections);
  const addSqlLog = useStore(state => state.addSqlLog);
  const fetchSeqRef = useRef(0);
  const countSeqRef = useRef(0);
  const countKeyRef = useRef<string>('');
  const pkSeqRef = useRef(0);
  const pkKeyRef = useRef<string>('');

  const [pagination, setPagination] = useState({
      current: 1,
      pageSize: 100,
      total: 0,
      totalKnown: false
  });

  const [sortInfo, setSortInfo] = useState<{ columnKey: string, order: string } | null>(null);
  
  const [showFilter, setShowFilter] = useState(false);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const currentConnType = (connections.find(c => c.id === tab.connectionId)?.config?.type || '').toLowerCase();
  const forceReadOnly = currentConnType === 'tdengine';

  useEffect(() => {
    setPkColumns([]);
    pkKeyRef.current = '';
    countKeyRef.current = '';
    setPagination(prev => ({ ...prev, current: 1, total: 0, totalKnown: false }));
  }, [tab.connectionId, tab.dbName, tab.tableName]);

  const fetchData = useCallback(async (page = pagination.current, size = pagination.pageSize) => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
        message.error("Connection not found");
        if (fetchSeqRef.current === seq) setLoading(false);
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

    const dbType = config.type || '';
    const dbTypeLower = String(dbType || '').trim().toLowerCase();
    const isMySQLFamily = dbTypeLower === 'mysql' || dbTypeLower === 'mariadb';

    const dbName = tab.dbName || '';
    const tableName = tab.tableName || '';

    const whereSQL = buildWhereSQL(dbType, filterConditions);

    const countSql = `SELECT COUNT(*) as total FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
    
    let sql = `SELECT * FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
    sql += buildOrderBySQL(dbType, sortInfo, pkColumns);
    const offset = (page - 1) * size;
    // 大表性能：打开表不阻塞在 COUNT(*)，先通过多取 1 条判断是否还有下一页；总数在后台统计并异步回填。
    sql += ` LIMIT ${size + 1} OFFSET ${offset}`;

    const requestStartTime = Date.now();
    let executedSql = sql;
    try {
        const executeDataQuery = async (querySql: string, attemptLabel: string) => {
            const startTime = Date.now();
            const result = await DBQuery(config as any, dbName, querySql);
            addSqlLog({
                id: `log-${Date.now()}-data`,
                timestamp: Date.now(),
                sql: querySql,
                status: result.success ? 'success' : 'error',
                duration: Date.now() - startTime,
                message: result.success ? '' : `${attemptLabel}: ${result.message}`,
                affectedRows: Array.isArray(result.data) ? result.data.length : undefined,
                dbName
            });
            return result;
        };

        const hasSort = !!sortInfo?.columnKey && (sortInfo?.order === 'ascend' || sortInfo?.order === 'descend');
        const isSortMemoryErr = (msg: string) => /error\s*1038|out of sort memory/i.test(String(msg || ''));
        let resData = await executeDataQuery(sql, '主查询');

        if (!resData.success && isMySQLFamily && hasSort && isSortMemoryErr(resData.message)) {
            const retrySql32MB = withSortBufferTuningSQL(dbType, sql, 32 * 1024 * 1024);
            if (retrySql32MB !== sql) {
                executedSql = retrySql32MB;
                resData = await executeDataQuery(retrySql32MB, '重试(32MB sort_buffer)');
            }
            if (!resData.success && isSortMemoryErr(resData.message)) {
                const retrySql128MB = withSortBufferTuningSQL(dbType, sql, 128 * 1024 * 1024);
                if (retrySql128MB !== executedSql) {
                    executedSql = retrySql128MB;
                    resData = await executeDataQuery(retrySql128MB, '重试(128MB sort_buffer)');
                }
            }
            if (resData.success) {
                message.warning('已自动提升排序缓冲并重试成功。');
            }
        }
        
        if (pkColumns.length === 0) {
            const pkKey = `${tab.connectionId}|${dbName}|${tableName}`;
            if (pkKeyRef.current !== pkKey) {
                pkKeyRef.current = pkKey;
                const pkSeq = ++pkSeqRef.current;
                DBGetColumns(config as any, dbName, tableName)
                    .then((resCols: any) => {
                        if (pkSeqRef.current !== pkSeq) return;
                        if (pkKeyRef.current !== pkKey) return;
                        if (!resCols?.success) return;
                        const pks = (resCols.data as ColumnDefinition[]).filter((c: any) => c.key === 'PRI').map((c: any) => c.name);
                        setPkColumns(pks);
                    })
                    .catch(() => {
                        if (pkSeqRef.current !== pkSeq) return;
                        if (pkKeyRef.current !== pkKey) return;
                    });
            }
        }

        if (resData.success) {
            let resultData = resData.data as any[];
            if (!Array.isArray(resultData)) resultData = [];

            const hasMore = resultData.length > size;
            if (hasMore) resultData = resultData.slice(0, size);

            let fieldNames = resData.fields || [];
            if (fieldNames.length === 0 && resultData.length > 0) {
                fieldNames = Object.keys(resultData[0]);
            }
            if (fetchSeqRef.current !== seq) return;
            setColumnNames(fieldNames);
            resultData.forEach((row: any, i: number) => {
                if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = `row-${offset + i}`;
            });
            setData(resultData);
            const countKey = `${tab.connectionId}|${dbName}|${tableName}|${whereSQL}`;
            const derivedTotalKnown = !hasMore;
            const derivedTotal = derivedTotalKnown ? offset + resultData.length : page * size + 1;
            if (derivedTotalKnown) countKeyRef.current = countKey;

            setPagination(prev => {
                if (derivedTotalKnown) {
                    return { ...prev, current: page, pageSize: size, total: derivedTotal, totalKnown: true };
                }
                if (prev.totalKnown && countKeyRef.current === countKey) {
                    return { ...prev, current: page, pageSize: size };
                }
                return { ...prev, current: page, pageSize: size, total: derivedTotal, totalKnown: false };
            });

            if (!derivedTotalKnown) {
                if (countKeyRef.current !== countKey) {
                    countKeyRef.current = countKey;
                    const countSeq = ++countSeqRef.current;
                    const countStart = Date.now();
                    // 大表 COUNT(*) 可能非常慢，且在部分运行时环境下会影响后续操作响应；
                    // 这里为统计请求设置更短的超时，避免“后台统计”长期占用资源。
                    const countConfig: any = { ...(config as any), timeout: 5 };

                    DBQuery(countConfig, dbName, countSql)
                        .then((resCount: any) => {
                            const countDuration = Date.now() - countStart;

                            addSqlLog({
                                id: `log-${Date.now()}-count`,
                                timestamp: Date.now(),
                                sql: countSql,
                                status: resCount.success ? 'success' : 'error',
                                duration: countDuration,
                                message: resCount.success ? '' : resCount.message,
                                dbName
                            });

                            if (countSeqRef.current !== countSeq) return;
                            if (countKeyRef.current !== countKey) return;

                            if (!resCount.success) return;
                            if (!Array.isArray(resCount.data) || resCount.data.length === 0) return;

                            const total = Number(resCount.data[0]?.['total']);
                            if (!Number.isFinite(total) || total < 0) return;

                            setPagination(prev => ({ ...prev, total, totalKnown: true }));
                        })
                        .catch(() => {
                            if (countSeqRef.current !== countSeq) return;
                            if (countKeyRef.current !== countKey) return;
                            // 统计失败不影响主流程，不弹窗；可在日志里查看。
                        });
                }
            }
        } else {
            message.error(String(resData.message || '查询失败'));
        }
    } catch (e: any) {
        if (fetchSeqRef.current !== seq) return;
        message.error("Error fetching data: " + e.message);
        addSqlLog({
            id: `log-${Date.now()}-error`,
            timestamp: Date.now(),
            sql: executedSql,
            status: 'error',
            duration: Date.now() - requestStartTime,
            message: e.message,
            dbName
        });
    }
    if (fetchSeqRef.current === seq) setLoading(false);
  }, [connections, tab, sortInfo, filterConditions, pkColumns]); 
  // 依赖 pkColumns：在无手动排序时可回退到主键稳定排序。
  // 主键信息只会在首次加载后更新一次，避免循环查询。

  // Handlers memoized
  const handleReload = useCallback(() => {
    fetchData(pagination.current, pagination.pageSize);
  }, [fetchData, pagination.current, pagination.pageSize]);
  const handleSort = useCallback((field: string, order: string) => {
    const normalizedOrder = order === 'ascend' || order === 'descend' ? order : '';
    const normalizedField = String(field || '').trim();
    if (!normalizedField || !normalizedOrder) {
      setSortInfo(null);
      return;
    }
    setSortInfo({ columnKey: normalizedField, order: normalizedOrder });
  }, []);
  const handlePageChange = useCallback((page: number, size: number) => fetchData(page, size), [fetchData]);
  const handleToggleFilter = useCallback(() => setShowFilter(prev => !prev), []);
  const handleApplyFilter = useCallback((conditions: FilterCondition[]) => setFilterConditions(conditions), []);

  useEffect(() => {
    fetchData(1, pagination.pageSize); 
  }, [tab, sortInfo, filterConditions]); // Initial load and re-load on sort/filter

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, height: '100%', width: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <DataGrid
          data={data}
          columnNames={columnNames}
          loading={loading}
          tableName={tab.tableName}
          dbName={tab.dbName}
          connectionId={tab.connectionId}
          pkColumns={pkColumns}
          onReload={handleReload}
          onSort={handleSort}
          onPageChange={handlePageChange}
          pagination={pagination}
          showFilter={showFilter}
          onToggleFilter={handleToggleFilter}
          onApplyFilter={handleApplyFilter}
          readOnly={forceReadOnly}
          sortInfoExternal={sortInfo}
      />
    </div>
  );
};

export default DataViewer;
