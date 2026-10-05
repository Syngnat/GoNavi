import { useMemo, useEffect } from 'react';
import type {
    ForeignKeyDisplayRow,
    TDengineTagDraft,
    IndexKind,
    EditableColumn,
    SchemaExecutionOptions,
    SchemaExecutionResult,
} from '../tableDesignerTypes';
import { t } from '../../../i18n';
import { resolveColumnTypeOptions } from '../../../utils/sqlDialect';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
    buildTDengineStableQueries,
    buildTDengineStableOptions,
} from '../../../utils/tdengineStableMetadata';
import { DBQuery, DBGetColumns } from '../../../../wailsjs/go/app/App';
import type {
    StarRocksCreateTableOptions,
    TDengineCreateTableOptions,
} from '../../tableDesignerSchemaSql';
import { supportsTableDesignerTableComment } from '../../tableDesignerTableCommentSql';
import {
    PGLIKE_INDEX_TYPE_OPTIONS,
    SQLSERVER_INDEX_TYPE_OPTIONS,
} from '../tableDesignerTypeOptions';
import type { IndexFormSnapshot } from '../../tableDesignerIndexUtils';
import { toForeignKeySqlForms } from '../../tableDesignerForeignKeyUtils';
import { TriggerDefinition } from '../../../types';
import { buildNewTablePreviewSql } from '../../tableDesignerCreateTableSql';
import { qualifyTableDesignerCreateName } from '../../tableDesignerSchemaContext';
import { confirmProductionRisk } from '../../../utils/productionRiskConfirm';
import type { TableDesignerStateApi } from './useTableDesignerState';
import type { TableDesignerColumnEditsApi } from './useTableDesignerColumnEdits';
import type { TableDesignerTriggerListApi } from './useTableDesignerTriggerList';
import type { TableDesignerProps } from '../../TableDesigner';
import { filterIndexKindsByDesign, getRegistryIndexDesign } from '../../../utils/dataSourceRegistry/indexDesign';

export interface UseTableDesignerDialectSupportInput {
    fks: TableDesignerStateApi['fks'];
    i18nLanguage: TableDesignerStateApi['i18nLanguage'];
    columns: TableDesignerStateApi['columns'];
    isNewTable: TableDesignerStateApi['isNewTable'];
    getDbType: TableDesignerStateApi['getDbType'];
    isTDengineNewTable: TableDesignerStateApi['isTDengineNewTable'];
    tdengineTableKind: TableDesignerStateApi['tdengineTableKind'];
    tab: TableDesignerProps['tab'];
    setActiveKey: TableDesignerStateApi['setActiveKey'];
    setTdengineStableOptions: TableDesignerStateApi['setTdengineStableOptions'];
    setTdengineStableOptionsLoading: TableDesignerStateApi['setTdengineStableOptionsLoading'];
    connections: TableDesignerStateApi['connections'];
    tdengineStableName: TableDesignerStateApi['tdengineStableName'];
    setTdengineChildTagDefs: TableDesignerStateApi['setTdengineChildTagDefs'];
    setTdengineChildTagValues: TableDesignerStateApi['setTdengineChildTagValues'];
    setTdengineChildTagDefsLoading: TableDesignerStateApi['setTdengineChildTagDefsLoading'];
    starRocksTableKind: TableDesignerStateApi['starRocksTableKind'];
    starRocksKeyModel: TableDesignerStateApi['starRocksKeyModel'];
    starRocksKeyColumns: TableDesignerStateApi['starRocksKeyColumns'];
    starRocksPartitionClause: TableDesignerStateApi['starRocksPartitionClause'];
    starRocksDistributionType: TableDesignerStateApi['starRocksDistributionType'];
    starRocksDistributionColumns: TableDesignerStateApi['starRocksDistributionColumns'];
    starRocksBucketMode: TableDesignerStateApi['starRocksBucketMode'];
    starRocksBucketCount: TableDesignerStateApi['starRocksBucketCount'];
    starRocksProperties: TableDesignerStateApi['starRocksProperties'];
    starRocksRollups: TableDesignerStateApi['starRocksRollups'];
    starRocksExternalEngine: TableDesignerStateApi['starRocksExternalEngine'];
    starRocksExternalProperties: TableDesignerStateApi['starRocksExternalProperties'];
    tdengineTagValues: TableDesignerStateApi['tdengineTagValues'];
    tdengineChildTagDefs: TableDesignerStateApi['tdengineChildTagDefs'];
    tdengineChildTagValues: TableDesignerStateApi['tdengineChildTagValues'];
    tdengineTagDefinitions: TableDesignerStateApi['tdengineTagDefinitions'];
    selectedIndexKeys: TableDesignerStateApi['selectedIndexKeys'];
    setSelectedIndexKeys: TableDesignerStateApi['setSelectedIndexKeys'];
    groupedIndexes: TableDesignerColumnEditsApi['groupedIndexes'];
    selectedForeignKey: TableDesignerStateApi['selectedForeignKey'];
    setSelectedForeignKey: TableDesignerStateApi['setSelectedForeignKey'];
    isNonRelationalDialect: TableDesignerStateApi['isNonRelationalDialect'];
    lacksAlterForeignKeySupport: TableDesignerStateApi['lacksAlterForeignKeySupport'];
    isMysqlLikeDialect: TableDesignerStateApi['isMysqlLikeDialect'];
    isPgLikeDialect: TableDesignerStateApi['isPgLikeDialect'];
    isSqlServerDialect: TableDesignerStateApi['isSqlServerDialect'];
    selectedSchema: TableDesignerStateApi['selectedSchema'];
    supportsTableDesignerSchemaSelection: TableDesignerTriggerListApi['supportsTableDesignerSchemaSelection'];
    designerSchemaTitle: TableDesignerStateApi['designerSchemaTitle'];
    executeSchemaStatements: (sqlText: string, options?: SchemaExecutionOptions) => Promise<SchemaExecutionResult>;
}

export const useTableDesignerDialectSupport = ({
    fks, i18nLanguage, columns, isNewTable, getDbType, isTDengineNewTable, tdengineTableKind, tab,
    setActiveKey, setTdengineStableOptions, setTdengineStableOptionsLoading, connections,
    tdengineStableName, setTdengineChildTagDefs, setTdengineChildTagValues,
    setTdengineChildTagDefsLoading, starRocksTableKind, starRocksKeyModel, starRocksKeyColumns,
    starRocksPartitionClause, starRocksDistributionType, starRocksDistributionColumns,
    starRocksBucketMode, starRocksBucketCount, starRocksProperties, starRocksRollups,
    starRocksExternalEngine, starRocksExternalProperties, tdengineTagValues, tdengineChildTagDefs,
    tdengineChildTagValues, tdengineTagDefinitions, selectedIndexKeys, setSelectedIndexKeys,
    groupedIndexes, selectedForeignKey, setSelectedForeignKey, isNonRelationalDialect,
    lacksAlterForeignKeySupport, isMysqlLikeDialect, isPgLikeDialect, isSqlServerDialect,
    selectedSchema, supportsTableDesignerSchemaSelection, designerSchemaTitle,
    executeSchemaStatements,
}: UseTableDesignerDialectSupportInput) => {
    const groupedForeignKeys = useMemo<ForeignKeyDisplayRow[]>(() => {
        type FieldItem = { name: string; order: number };
        type FkBucket = {
            key: string;
            constraintName: string;
            refTableName: string;
            order: number;
            columns: FieldItem[];
            refColumns: FieldItem[];
        };

        const buckets = new Map<string, FkBucket>();

        const safeFks = Array.isArray(fks) ? fks : [];
        safeFks.forEach((fk, order) => {
            const rawConstraint = String(fk.constraintName || fk.name || '').trim();
            const key = rawConstraint || `__unnamed_fk_${order}`;
            const constraintName = rawConstraint || t('table_designer.fallback.unnamed_foreign_key', undefined, i18nLanguage);
            const refTableName = String(fk.refTableName || '').trim() || '-';

            if (!buckets.has(key)) {
                buckets.set(key, {
                    key,
                    constraintName,
                    refTableName,
                    order,
                    columns: [],
                    refColumns: [],
                });
            }

            const bucket = buckets.get(key);
            if (!bucket) return;

            if (bucket.refTableName === '-' && refTableName !== '-') {
                bucket.refTableName = refTableName;
            }

            const colName = String(fk.columnName || '').trim();
            const refColName = String(fk.refColumnName || '').trim();
            if (colName) bucket.columns.push({ name: colName, order });
            if (refColName) bucket.refColumns.push({ name: refColName, order });
        });

        return Array.from(buckets.values())
            .sort((a, b) => a.order - b.order)
            .map((bucket) => {
                const columnNames = bucket.columns
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map(item => item.name);
                const refColumnNames = bucket.refColumns
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map(item => item.name);

                return {
                    key: bucket.key,
                    name: bucket.constraintName,
                    constraintName: bucket.constraintName,
                    refTableName: bucket.refTableName,
                    columnNames: Array.from(new Set(columnNames)),
                    refColumnNames: Array.from(new Set(refColumnNames)),
                };
            });
    }, [fks, i18nLanguage]);

    const localColumnOptions = useMemo(
        () => columns.map(col => ({ label: col.name, value: col.name })),
        [columns]
    );

    const isStarRocksNewTable = isNewTable && getDbType() === 'starrocks';
    const isTDengineChildNewTable = isTDengineNewTable && tdengineTableKind === 'child';
    const tdengineTagTypeOptions = useMemo(
        () => resolveColumnTypeOptions('tdengine').filter(option => option.value !== 'TIMESTAMP'),
        [],
    );

    useEffect(() => {
        if (isTDengineNewTable && (!tab.initialTab || tab.initialTab === 'columns')) {
            setActiveKey('tdengine');
        }
    }, [isTDengineNewTable, tab.initialTab]);

    useEffect(() => {
        if (!isTDengineChildNewTable) {
            setTdengineStableOptions([]);
            return;
        }
        let cancelled = false;
        const fetchSuperTables = async () => {
            setTdengineStableOptionsLoading(true);
            setTdengineStableOptions([]);
            try {
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
                const rpcConfig = buildRpcConnectionConfig(config) as any;
                const dbName = tab.dbName || '';
                for (const query of buildTDengineStableQueries(dbName)) {
                    const res = await DBQuery(rpcConfig, dbName, query);
                    if (cancelled) return;
                    if (!res?.success || !Array.isArray(res.data)) continue;
                    const options = buildTDengineStableOptions(res.data);
                    if (options.length > 0) {
                        setTdengineStableOptions(options);
                        return;
                    }
                }
                if (!cancelled) setTdengineStableOptions([]);
            } catch {
                if (!cancelled) setTdengineStableOptions([]);
            } finally {
                if (!cancelled) setTdengineStableOptionsLoading(false);
            }
        };
        fetchSuperTables();
        return () => { cancelled = true; };
    }, [isTDengineChildNewTable, tab.connectionId, tab.dbName, connections]);

	  useEffect(() => {
	      if (!isTDengineChildNewTable || !tdengineStableName.trim()) {
	          setTdengineChildTagDefs([]);
	          setTdengineChildTagValues({});
	          return;
	      }
	      let cancelled = false;
	      const fetchTagDefs = async () => {
	          setTdengineChildTagDefsLoading(true);
	          try {
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
	              const rpcConfig = buildRpcConnectionConfig(config) as any;
	              const dbName = tab.dbName || '';
	              const res = await DBGetColumns(rpcConfig, dbName, tdengineStableName.trim());
	              if (cancelled) return;
	              if (res.success && Array.isArray(res.data)) {
	                  const tagDefs: TDengineTagDraft[] = res.data
	                      .filter((col: any) => (col?.key || col?.Key || '') === 'TAG')
	                      .map((col: any, idx: number) => ({
	                          _key: `tagdef-${idx}`,
	                          name: String(col?.name || col?.Name || ''),
	                          type: String(col?.type || col?.Type || ''),
	                      }));
	                  setTdengineChildTagDefs(tagDefs);
	                  setTdengineChildTagValues({});
	              } else {
	                  setTdengineChildTagDefs([]);
	                  setTdengineChildTagValues({});
	              }
	          } catch {
	              if (!cancelled) {
	                  setTdengineChildTagDefs([]);
	                  setTdengineChildTagValues({});
	              }
	          } finally {
	              if (!cancelled) setTdengineChildTagDefsLoading(false);
	          }
	      };
	      fetchTagDefs();
	      return () => { cancelled = true; };
	  }, [isTDengineChildNewTable, tdengineStableName, tab.connectionId, tab.dbName, connections]);

    const parseStarRocksRollupOptions = (raw: string): StarRocksCreateTableOptions['rollups'] => (
        String(raw || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const [namePart, columnsPart] = line.split(':');
                const name = String(namePart || '').trim();
                const columnNames = String(columnsPart || '')
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean);
                return { name, columnNames };
            })
            .filter(item => item.name && item.columnNames.length > 0)
    );

    const buildStarRocksCreateOptions = (): StarRocksCreateTableOptions | undefined => {
        if (!isStarRocksNewTable) return undefined;
        return {
            tableKind: starRocksTableKind,
            keyModel: starRocksKeyModel,
            keyColumnNames: starRocksKeyColumns,
            partitionClause: starRocksPartitionClause,
            distributionType: starRocksDistributionType,
            distributionColumnNames: starRocksDistributionColumns,
            bucketMode: starRocksBucketMode,
            bucketCount: Number(starRocksBucketCount) || undefined,
            properties: starRocksProperties,
            rollups: parseStarRocksRollupOptions(starRocksRollups),
            externalEngine: starRocksExternalEngine,
            externalProperties: starRocksExternalProperties,
        };
    };

    const buildTDengineCreateOptions = (): TDengineCreateTableOptions | undefined => {
        if (!isTDengineNewTable) return undefined;
        let tagValues = tdengineTagValues;
        if (tdengineTableKind === 'child' && tdengineChildTagDefs.length > 0) {
            tagValues = tdengineChildTagDefs
                .map(tag => {
                    const val = tdengineChildTagValues[tag.name] ?? '';
                    if (!val) return '';
                    const needQuote = /^(BINARY|NCHAR|VARBINARY|TIMESTAMP)/i.test(tag.type);
                    return needQuote ? `'${val.replace(/'/g, "\\'")}'` : val;
                })
                .filter(Boolean)
                .join(', ');
        }
        return {
            tableKind: tdengineTableKind,
            stableName: tdengineStableName,
            tagDefinitions: tdengineTagDefinitions.map(({ _key, ...tag }) => tag),
            tagValues,
        };
    };

    useEffect(() => {
        if (selectedIndexKeys.length === 0) return;
        const validKeys = selectedIndexKeys.filter(key => groupedIndexes.some(idx => idx.key === key));
        if (validKeys.length !== selectedIndexKeys.length) {
            setSelectedIndexKeys(validKeys);
        }
    }, [groupedIndexes, selectedIndexKeys]);

    useEffect(() => {
        if (!selectedForeignKey) return;
        if (!groupedForeignKeys.some(fk => fk.key === selectedForeignKey.key)) {
            setSelectedForeignKey(null);
        }
    }, [groupedForeignKeys, selectedForeignKey]);

    const supportsIndexSchemaOps = (): boolean => {
        const dbType = getDbType();
        if (!dbType) return false;
        if (isNonRelationalDialect(dbType)) return false;
        return true;
    };

    const supportsForeignKeySchemaOps = (): boolean => {
        const dbType = getDbType();
        if (!dbType) return false;
        if (isNonRelationalDialect(dbType)) return false;
        if (lacksAlterForeignKeySupport(dbType)) return false;
        return true;
    };

    const supportsTableCommentOps = (): boolean => supportsTableDesignerTableComment(getDbType());

    // 描述表声明的索引限制（如 GBase 8a 只能建普通 HASH 索引）优先于借用方言的规则。
    const getRegistryIndexDesignForTab = () => getRegistryIndexDesign(
        connections.find(c => c.id === tab.connectionId)?.config?.type,
    );

    const getIndexKindOptions = () => filterIndexKindsByDesign(getDialectIndexKindOptions(), getRegistryIndexDesignForTab());

    const getDialectIndexKindOptions = () => {
        const dbType = getDbType();
        if (isMysqlLikeDialect(dbType)) {
            return [
                { label: t('table_designer.index.kind.normal_nonclustered', undefined, i18nLanguage), value: 'NORMAL' },
                { label: t('table_designer.index.kind.unique', undefined, i18nLanguage), value: 'UNIQUE' },
                { label: t('table_designer.index.kind.primary_clustered', undefined, i18nLanguage), value: 'PRIMARY' },
                { label: t('table_designer.index.kind.fulltext', undefined, i18nLanguage), value: 'FULLTEXT' },
                { label: t('table_designer.index.kind.spatial', undefined, i18nLanguage), value: 'SPATIAL' },
            ];
        }
        return [
            { label: t('table_designer.index.kind.normal', undefined, i18nLanguage), value: 'NORMAL' },
            { label: t('table_designer.index.kind.unique', undefined, i18nLanguage), value: 'UNIQUE' },
        ];
    };

    const getIndexTypeOptions = (kind?: IndexKind) => {
        const registryDesign = getRegistryIndexDesignForTab();
        const dbType = getDbType();
        const k = kind || 'NORMAL';
        if (registryDesign) {
            if (isPgLikeDialect(dbType) && (k === 'PRIMARY' || k === 'UNIQUE') && registryDesign.methods.includes('BTREE')) {
                return [{ label: 'BTREE', value: 'BTREE' }];
            }
            return registryDesign.methods.map(method => ({
                label: method === 'DEFAULT' ? t('table_designer.option.default', undefined, i18nLanguage) : method,
                value: method,
            }));
        }
        if (isMysqlLikeDialect(dbType)) {
            // MySQL InnoDB: 所有索引均为固定方法类型
            if (k === 'FULLTEXT') return [{ label: 'FULLTEXT', value: 'FULLTEXT' }];
            if (k === 'SPATIAL') return [{ label: 'RTREE', value: 'RTREE' }];
            return [{ label: 'BTREE', value: 'BTREE' }];
        }
        if (isPgLikeDialect(dbType)) {
            if (k === 'PRIMARY' || k === 'UNIQUE') return [{ label: 'BTREE', value: 'BTREE' }];
            return PGLIKE_INDEX_TYPE_OPTIONS.map(option => option.value === 'DEFAULT'
                ? { ...option, label: t('table_designer.option.default', undefined, i18nLanguage) }
                : option);
        }
        if (isSqlServerDialect(dbType)) {
            return SQLSERVER_INDEX_TYPE_OPTIONS.map(option => option.value === 'DEFAULT'
                ? { ...option, label: t('table_designer.option.default', undefined, i18nLanguage) }
                : option);
        }
        return [{ label: t('table_designer.option.default', undefined, i18nLanguage), value: 'DEFAULT' }];
    };

    /** 根据索引类别返回固定的索引方法类型，可选类别返回 undefined */
    const getFixedIndexType = (kind: IndexKind): string | undefined => {
        const registryDesign = getRegistryIndexDesignForTab();
        if (registryDesign?.methods.length === 1) {
            return registryDesign.methods[0];
        }
        const dbType = getDbType();
        if (isMysqlLikeDialect(dbType)) {
            if (kind === 'PRIMARY') return 'BTREE';
            if (kind === 'FULLTEXT') return 'FULLTEXT';
            if (kind === 'SPATIAL') return 'RTREE';
        }
        if (isPgLikeDialect(dbType)) {
            if (kind === 'PRIMARY') return 'BTREE';
        }
        return undefined;
    };

    const buildCreateTableSql = (
        targetTableName: string,
        targetColumns: EditableColumn[],
        targetCharset: string,
        targetCollation: string,
        extras?: {
            comment?: string;
            indexes?: IndexFormSnapshot[];
            foreignKeys?: ReturnType<typeof toForeignKeySqlForms>;
            triggers?: TriggerDefinition[];
        },
    ) => {
        const dbType = getDbType();
        return buildNewTablePreviewSql({
            dbType,
            tableName: qualifyTableDesignerCreateName(targetTableName, selectedSchema, dbType),
            columns: targetColumns,
            charset: targetCharset,
            collation: targetCollation,
            starRocksOptions: buildStarRocksCreateOptions(),
            tdengineOptions: buildTDengineCreateOptions(),
            translate: (key, params) => t(key, params, i18nLanguage),
            comment: extras?.comment,
            indexes: extras?.indexes,
            foreignKeys: extras?.foreignKeys,
            triggers: extras?.triggers,
        });
    };

    const handleCopyColumnsExecute = async (
        sql: string,
        target: { tableName: string; kind: 'create' | 'alter' },
    ) => {
        const conn = connections.find(c => c.id === tab.connectionId);
        if (!conn) {
            return {
                ok: false,
                message: t('table_designer.message.connection_not_found', undefined, i18nLanguage),
                statementCount: 0,
            };
        }
        const approved = await confirmProductionRisk({
            connection: conn,
            action: t('connection.production_risk.action.execute_sql'),
            target: [
                tab.dbName,
                supportsTableDesignerSchemaSelection ? designerSchemaTitle : '',
                target.tableName,
            ].filter(Boolean).join(' / '),
            translate: (key, params) => t(key, params, i18nLanguage),
        });
        if (!approved) {
            return { ok: false, cancelled: true, statementCount: 0 };
        }
        return executeSchemaStatements(sql, { skipProductionRiskConfirm: true });
    };

    const copyColumnsRpcConfig = useMemo(() => {
        const conn = connections.find(c => c.id === tab.connectionId);
        if (!conn) return null;
        return buildRpcConnectionConfig({
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || '',
            database: conn.config.database || '',
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
        });
    }, [connections, tab.connectionId]);
    return {
        groupedForeignKeys, localColumnOptions, isStarRocksNewTable, isTDengineChildNewTable,
        tdengineTagTypeOptions, supportsIndexSchemaOps, supportsForeignKeySchemaOps,
        supportsTableCommentOps, getIndexKindOptions, getIndexTypeOptions, getFixedIndexType,
        buildCreateTableSql, handleCopyColumnsExecute, copyColumnsRpcConfig,
    };
};

export type TableDesignerDialectSupportApi = ReturnType<typeof useTableDesignerDialectSupport>;
