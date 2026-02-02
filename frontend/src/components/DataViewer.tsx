import React, { useEffect, useState, useCallback } from 'react';
import { message } from 'antd';
import { TabData, ColumnDefinition } from '../types';
import { useStore } from '../store';
import { MySQLQuery, DBGetColumns } from '../../wailsjs/go/app/App';
import DataGrid from './DataGrid';

const DataViewer: React.FC<{ tab: TabData }> = ({ tab }) => {
  const [data, setData] = useState<any[]>([]);
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const { connections, addSqlLog } = useStore();

  const [pagination, setPagination] = useState({
      current: 1,
      pageSize: 100,
      total: 0
  });

  const [sortInfo, setSortInfo] = useState<{ columnKey: string, order: string } | null>(null);
  
  const [showFilter, setShowFilter] = useState(false);
  const [filterConditions, setFilterConditions] = useState<any[]>([]);

  const fetchData = useCallback(async (page = pagination.current, size = pagination.pageSize) => {
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

    const dbName = tab.dbName || '';
    const tableName = tab.tableName || '';

    const whereParts: string[] = [];
    filterConditions.forEach(cond => {
        if (cond.column && cond.value) {
            if (cond.op === 'LIKE') {
                whereParts.push(`\`${cond.column}\` LIKE '%${cond.value}%'`);
            } else {
                whereParts.push(`\`${cond.column}\` ${cond.op} '${cond.value}'`);
            }
        }
    });
    const whereSQL = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : "";

    const countSql = `SELECT COUNT(*) as total FROM \`${tableName}\` ${whereSQL}`;
    
    let sql = `SELECT * FROM \`${tableName}\` ${whereSQL}`;
    if (sortInfo && sortInfo.order) {
        sql += ` ORDER BY \`${sortInfo.columnKey}\` ${sortInfo.order === 'ascend' ? 'ASC' : 'DESC'}`;
    }
    const offset = (page - 1) * size;
    sql += ` LIMIT ${size} OFFSET ${offset}`;

    const startTime = Date.now();
    try {
        const pCount = MySQLQuery(config as any, dbName, countSql);
        const pData = MySQLQuery(config as any, dbName, sql);
        
        let pCols = null;
        if (pkColumns.length === 0) {
             pCols = DBGetColumns(config as any, dbName, tableName);
        }

        const [resCount, resData] = await Promise.all([pCount, pData]);
        const duration = Date.now() - startTime;
        
        // Log Execution
        addSqlLog({
            id: `log-${Date.now()}-count`,
            timestamp: Date.now(),
            sql: countSql,
            status: resCount.success ? 'success' : 'error',
            duration: duration / 2, // Estimate
            message: resCount.success ? '' : resCount.message,
            dbName
        });
        
        addSqlLog({
            id: `log-${Date.now()}-data`,
            timestamp: Date.now(),
            sql: sql,
            status: resData.success ? 'success' : 'error',
            duration: duration,
            message: resData.success ? '' : resData.message,
            affectedRows: Array.isArray(resData.data) ? resData.data.length : undefined,
            dbName
        });
        
        if (pCols) {
            const resCols = await pCols;
            if (resCols.success) {
                const pks = (resCols.data as ColumnDefinition[]).filter(c => c.key === 'PRI').map(c => c.name);
                setPkColumns(pks);
            }
        }

        let totalRecords = 0;
        if (resCount.success && Array.isArray(resCount.data) && resCount.data.length > 0) {
            totalRecords = Number(resCount.data[0]['total']);
        }

        if (resData.success) {
            let resultData = resData.data as any[];
            if (!Array.isArray(resultData)) resultData = [];

            let fieldNames = resData.fields || [];
            if (fieldNames.length === 0 && resultData.length > 0) {
                fieldNames = Object.keys(resultData[0]);
            }
            setColumnNames(fieldNames);
            
            setData(resultData.map((row: any, i: number) => ({ ...row, key: `row-${i}` }))); 
            
            setPagination(prev => ({ ...prev, current: page, pageSize: size, total: totalRecords }));
        } else {
            message.error(resData.message);
        }
    } catch (e: any) {
        message.error("Error fetching data: " + e.message);
        addSqlLog({
            id: `log-${Date.now()}-error`,
            timestamp: Date.now(),
            sql: sql,
            status: 'error',
            duration: Date.now() - startTime,
            message: e.message,
            dbName
        });
    }
    setLoading(false);
  }, [connections, tab, sortInfo, filterConditions, pkColumns.length]); 
  // Depend on pkColumns.length to avoid loop? No, pkColumns is updated inside.
  // Actually, 'pkColumns' state shouldn't trigger re-fetch.
  // The 'if (pkColumns.length === 0)' check is inside.
  // So adding pkColumns to dependency is safer but might trigger double fetch if not careful?
  // Only if pkColumns changes. It changes once from [] to [...].
  // So it's fine.

  // Handlers memoized
  const handleReload = useCallback(() => fetchData(), [fetchData]);
  const handleSort = useCallback((field: string, order: string) => setSortInfo({ columnKey: field, order }), []);
  const handlePageChange = useCallback((page: number, size: number) => fetchData(page, size), [fetchData]);
  const handleToggleFilter = useCallback(() => setShowFilter(prev => !prev), []);
  const handleApplyFilter = useCallback((conditions: any[]) => setFilterConditions(conditions), []);

  useEffect(() => {
    fetchData(1, pagination.pageSize); 
  }, [tab, sortInfo, filterConditions]); // Initial load and re-load on sort/filter

  return (
    <div style={{ height: '100%', width: '100%', overflow: 'hidden' }}>
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
      />
    </div>
  );
};

export default DataViewer;