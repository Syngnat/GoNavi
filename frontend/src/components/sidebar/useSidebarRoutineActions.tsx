import {
  resolveNodeSchemaName,
  buildMySqlEventReference,
  extractMySqlEventCreateSql,
  ensureSidebarObjectEditSqlTerminator,
} from './sidebarObjectActionHelpers';
import { t } from '../../i18n';
import {
  getMetadataDialect,
  splitQualifiedName,
  escapeSQLLiteral,
  buildDuckDBMacroDDL,
  getCaseInsensitiveRawValue,
  extractSqlServerDefinitionRows,
} from './sidebarMetadataLoaders';
import type { SavedConnection } from '../../types';
import { DBQuery, DBShowCreateTable, DropFunction } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { buildSqlServerObjectDefinitionQueries } from '../../utils/sqlServerObjectDefinition';
import Modal from '../common/ResizableDraggableModal';
import { message } from 'antd';
import {
  supportsOracleObjectCompilation,
  resolveOracleCompileTarget,
  buildOracleObjectCompileSQL,
  loadOracleCompileErrors,
  formatOracleCompileErrors,
} from './oracleObjectCompilation';
import type { SidebarCopyExportActionsApi } from './useSidebarCopyExportActions';
import type { UseSidebarObjectActionsArgs } from './useSidebarObjectActions';
import { buildPgRoutineDefinitionQuery } from '../../utils/pgRoutineDefinition';
import { usesDriverObjectDefinition } from '../definitionViewerDialect';

export interface UseSidebarRoutineActionsInput {
  addTab: UseSidebarObjectActionsArgs['addTab'];
  buildRuntimeConfig: UseSidebarObjectActionsArgs['buildRuntimeConfig'];
  loadTables: UseSidebarObjectActionsArgs['loadTables'];
  getDatabaseNodeRef: UseSidebarObjectActionsArgs['getDatabaseNodeRef'];
  confirmSidebarMutation: SidebarCopyExportActionsApi['confirmSidebarMutation'];
}

export const useSidebarRoutineActions = ({
  addTab, buildRuntimeConfig, loadTables, getDatabaseNodeRef, confirmSidebarMutation,
}: UseSidebarRoutineActionsInput) => {
  const openRoutineDefinition = (node: any) => {
    const { routineName, routineType, dbName, id } = node.dataRef;
    const schemaName = resolveNodeSchemaName(node);
    const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
    addTab({
      id: `routine-def-${id}-${dbName}${schemaName ? `-${schemaName}` : ''}-${routineName}`,
      title: t('sidebar.tab.routine_definition', { type: typeLabel, name: routineName }),
      type: 'routine-def',
      connectionId: id,
      dbName,
      routineName,
      routineType,
      schemaName,
    });
  };

  const openEventDefinition = (node: any) => {
    const { eventName, dbName, id } = node.dataRef;
    const schemaName = resolveNodeSchemaName(node);
    addTab({
      id: `event-def-${id}-${dbName}${schemaName ? `-${schemaName}` : ''}-${eventName}`,
      title: t('sidebar.tab.event', { name: eventName }),
      type: 'event-def',
      connectionId: id,
      dbName,
      eventName,
      schemaName,
    });
  };

  const openEditEvent = async (node: any) => {
    const conn = node.dataRef;
    const eventName = String(conn?.eventName || '').trim();
    const dbName = String(conn?.dbName || '').trim();
    const id = String(conn?.id || '').trim();
    const schemaName = resolveNodeSchemaName(node);
    if (!eventName) return;

    const objectLabel = t('definition_viewer.object.event');
    const header = [
      `-- ${t('definition_viewer.edit.comment_title', { object: objectLabel, name: eventName })}`,
      `-- ${t('definition_viewer.edit.comment_compatibility')}`,
    ].join('\n') + '\n';
    let template = `${header}-- ${t('definition_viewer.edit.comment_empty_definition', { name: eventName })}\n`;

    try {
      const dialect = getMetadataDialect(conn as SavedConnection);
      if (dialect === 'mysql') {
        const config = buildRuntimeConfig(conn, dbName);
        const eventRef = buildMySqlEventReference(eventName, conn?.schemaName || dbName);
        const result = await DBQuery(
          buildRpcConnectionConfig(config) as any,
          dbName,
          `SHOW CREATE EVENT ${eventRef}`,
        );
        if (result.success) {
          const createSql = extractMySqlEventCreateSql(result.data as any[]);
          if (createSql) {
            template = `${header}${ensureSidebarObjectEditSqlTerminator(createSql)}`;
          }
        }
      }
    } catch {
      // 降级使用空编辑模板，避免把 SHOW 语句当成可编辑定义。
    }

    addTab({
      id: `query-edit-event-${Date.now()}`,
      title: t('sidebar.tab.edit_event', { name: eventName }),
      type: 'query',
      connectionId: id,
      dbName,
      query: template,
      queryMode: 'object-edit',
      eventName,
      schemaName,
      sidebarLocateKey: String(node.key || ''),
    });
  };

  const openSequenceDefinition = (node: any) => {
    const { sequenceName, dbName, id } = node.dataRef;
    const schemaName = resolveNodeSchemaName(node);
    addTab({
      id: `sequence-def-${id}-${dbName}${schemaName ? `-${schemaName}` : ''}-${sequenceName}`,
      title: t('sidebar.tab.sequence_definition', { name: sequenceName }),
      type: 'sequence-def',
      connectionId: id,
      dbName,
      sequenceName,
      schemaName,
    });
  };

  const openPackageDefinition = (node: any) => {
    const { packageName, dbName, id } = node.dataRef;
    const schemaName = resolveNodeSchemaName(node);
    addTab({
      id: `package-def-${id}-${dbName}${schemaName ? `-${schemaName}` : ''}-${packageName}`,
      title: t('sidebar.tab.package_definition', { name: packageName }),
      type: 'package-def',
      connectionId: id,
      dbName,
      packageName,
      schemaName,
    });
  };

  const openEditRoutine = async (node: any) => {
    const conn = node.dataRef;
    const { routineName, routineType, dbName, id } = conn;
    const schemaName = resolveNodeSchemaName(node);
    const dialect = getMetadataDialect(conn as SavedConnection);
    const tabTypeKey = routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function';
    const tabTypeLabel = t(tabTypeKey);
    const sqlTemplateHeader = `-- ${t('sidebar.sql_template.edit_routine', { type: tabTypeLabel, name: routineName })}`;
    let template = sqlTemplateHeader;

    try {
      const config = buildRuntimeConfig(conn, dbName);
      let query = '';
      const parsedRoutine = splitQualifiedName(routineName);
      const name = parsedRoutine.objectName || routineName;
      const schema = parsedRoutine.schemaName;

      switch (dialect) {
        case 'mysql':
        case 'starrocks':
          query = `SHOW CREATE ${routineType} \`${name.replace(/`/g, '``')}\``;
          break;
        case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': case 'opengauss': case 'gaussdb': {
          const schemaRef = schema || 'public';
          query = buildPgRoutineDefinitionQuery(dialect, escapeSQLLiteral(schemaRef), escapeSQLLiteral(name));
          break;
        }
        case 'sqlserver':
          query = '';
          break;
        case 'oracle': case 'dm': {
          const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : '';
          if (owner) {
            query = `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${escapeSQLLiteral(name).toUpperCase()}' AND TYPE = '${routineType}' ORDER BY LINE`;
          } else {
            query = `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${escapeSQLLiteral(name).toUpperCase()}' AND TYPE = '${routineType}' ORDER BY LINE`;
          }
          break;
        }
        case 'duckdb': {
          const schemaRef = schema || 'main';
          query = `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = '${escapeSQLLiteral(schemaRef)}' AND function_name = '${escapeSQLLiteral(name)}' LIMIT 1`;
          break;
        }
      }
      if (usesDriverObjectDefinition(conn)) {
        const result = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, dbName, name);
        if (result.success && String(result.data || '').trim()) template = `${sqlTemplateHeader}
${String(result.data)}`;
      }
      const queries = usesDriverObjectDefinition(conn) ? [] : dialect === 'sqlserver'
        ? buildSqlServerObjectDefinitionQueries('routine', routineName, dbName, 'routine_definition')
        : [query].filter(Boolean);
      for (const queryText of queries) {
        const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, queryText);
        if (result.success && Array.isArray(result.data) && result.data.length > 0) {
          if (dialect === 'oracle' || dialect === 'dm') {
            const lines = result.data.map((row: any) => row.text || row.TEXT || Object.values(row)[0] || '').join('');
            if (lines) {
              template = `${sqlTemplateHeader}\nCREATE OR REPLACE ${lines}`;
              break;
            }
          } else if (dialect === 'duckdb') {
            const row = result.data[0] as Record<string, any>;
            const ddl = buildDuckDBMacroDDL(
              String(getCaseInsensitiveRawValue(row, ['schema_name']) || schema || '').trim(),
              String(getCaseInsensitiveRawValue(row, ['function_name']) || name || '').trim(),
              getCaseInsensitiveRawValue(row, ['parameters']),
              getCaseInsensitiveRawValue(row, ['macro_definition']),
            );
            if (ddl) {
              template = `${sqlTemplateHeader}\n${ddl}`;
              break;
            }
          } else {
            const row = result.data[0] as Record<string, any>;
            const def = dialect === 'sqlserver'
              ? extractSqlServerDefinitionRows(result.data, ['routine_definition', 'definition'])
              : row.routine_definition || row.ROUTINE_DEFINITION || Object.values(row).find(v => typeof v === 'string' && String(v).length > 10) || '';
            if (def) {
              template = `${sqlTemplateHeader}\n${def}`;
              break;
            }
          }
        }
      }
    } catch { /* 降级使用模板 */ }

    addTab({
      id: `query-edit-routine-${Date.now()}`,
      title: t('sidebar.tab.edit_routine', { type: tabTypeLabel, name: routineName }),
      type: 'query',
      connectionId: id,
      dbName,
      query: template,
      queryMode: 'object-edit',
      routineName,
      routineType,
      schemaName,
      sidebarLocateKey: String(node.key || ''),
    });
  };

  const openCreateRoutine = (node: any, type: 'FUNCTION' | 'PROCEDURE') => {
    const conn = node.dataRef;
    const { dbName, id } = conn;
    const schemaName = resolveNodeSchemaName(node);
    const dialect = getMetadataDialect(conn as SavedConnection);
    const isProc = type === 'PROCEDURE';
    let template: string;

    switch (dialect) {
      case 'mysql':
      case 'starrocks':
        template = isProc
          ? `DELIMITER $$\nCREATE PROCEDURE proc_name(IN param1 INT)\nBEGIN\n    SELECT * FROM table_name WHERE id = param1;\nEND$$\nDELIMITER ;`
          : `DELIMITER $$\nCREATE FUNCTION func_name(param1 INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n    RETURN param1 * 2;\nEND$$\nDELIMITER ;`;
        break;
      case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': case 'opengauss': case 'gaussdb':
        template = isProc
          ? `CREATE OR REPLACE PROCEDURE proc_name(param1 integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    -- procedure body\nEND;\n$$;`
          : `CREATE OR REPLACE FUNCTION func_name(param1 integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    RETURN param1 * 2;\nEND;\n$$;`;
        break;
      case 'sqlserver':
        template = isProc
          ? `CREATE PROCEDURE dbo.proc_name\n    @param1 INT\nAS\nBEGIN\n    SELECT * FROM table_name WHERE id = @param1;\nEND;`
          : `CREATE FUNCTION dbo.func_name(@param1 INT)\nRETURNS INT\nAS\nBEGIN\n    RETURN @param1 * 2;\nEND;`;
        break;
      case 'oracle': case 'dm':
        template = isProc
          ? `CREATE OR REPLACE PROCEDURE proc_name(param1 IN NUMBER)\nIS\nBEGIN\n    -- procedure body\n    NULL;\nEND;`
          : `CREATE OR REPLACE FUNCTION func_name(param1 IN NUMBER)\nRETURN NUMBER\nIS\nBEGIN\n    RETURN param1 * 2;\nEND;`;
        break;
      case 'duckdb':
        template = isProc
          ? `-- ${t('sidebar.sql_template.duckdb_procedure_unsupported')}\n-- ${t('sidebar.sql_template.duckdb_macro_hint')}\nCREATE MACRO func_name(param1) AS (param1 * 2);`
          : `CREATE MACRO func_name(param1) AS (param1 * 2);`;
        break;
      default:
        template = isProc
          ? `CREATE PROCEDURE proc_name()\nBEGIN\n    -- procedure body\nEND;`
          : `CREATE FUNCTION func_name()\nRETURNS INTEGER\nBEGIN\n    RETURN 0;\nEND;`;
    }

    addTab({
      id: `query-create-routine-${Date.now()}`,
      title: isProc ? t('sidebar.tab.create_procedure') : t('sidebar.tab.create_function'),
      type: 'query',
      connectionId: id,
      dbName,
      schemaName,
      query: template,
    });
  };

  const handleDropRoutine = (node: any) => {
    const conn = node.dataRef;
    const routineName = String(conn.routineName || '').trim();
    const routineType = String(conn.routineType || 'FUNCTION').trim();
    if (!routineName) return;
    const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
    Modal.confirm({
      title: t('sidebar.modal.confirm_delete_routine.title', { type: typeLabel }),
      content: t('sidebar.modal.confirm_delete_routine.content', { type: typeLabel, name: routineName }),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!await confirmSidebarMutation(conn, [conn.dbName, routineName].filter(Boolean).join(' / '))) return;
        const config = buildRuntimeConfig(conn, conn.dbName);
        const res = await DropFunction(buildRpcConnectionConfig(config) as any, conn.dbName, routineName, routineType);
        if (res.success) {
          await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
          message.success(t('sidebar.message.routine_deleted', { type: typeLabel }));
        } else {
          message.error(t('sidebar.message.delete_failed', { error: res.message }));
        }
      },
    });
  };

  const handleCompileOracleObject = async (node: any) => {
    const conn = node?.dataRef;
    if (!conn || !supportsOracleObjectCompilation(getMetadataDialect(conn as SavedConnection))) return;

    const isTrigger = node?.type === 'db-trigger';
    const objectName = String(
      isTrigger ? conn.triggerName : conn.routineName,
    ).trim();
    const objectLabel = isTrigger
      ? t('sidebar.object.trigger')
      : t(String(conn.routineType || '').toUpperCase() === 'PROCEDURE'
        ? 'sidebar.object.procedure'
        : 'sidebar.object.function');
    const compileTarget = resolveOracleCompileTarget({
      kind: isTrigger ? 'trigger' : 'routine',
      objectName,
      schemaName: conn.schemaName || conn.dbName,
      routineType: conn.routineType,
    });
    const compileSQL = buildOracleObjectCompileSQL({
      kind: isTrigger ? 'trigger' : 'routine',
      objectName,
      schemaName: conn.schemaName,
      routineType: conn.routineType,
    });
    if (!compileSQL || !compileTarget) {
      message.error(t('sidebar.message.object_compile_target_invalid'));
      return;
    }
    if (!await confirmSidebarMutation(
      conn,
      [conn.dbName, objectName].filter(Boolean).join(' / '),
    )) return;

    try {
      const config = buildRuntimeConfig(conn, conn.dbName);
      const rpcConfig = buildRpcConnectionConfig(config) as any;
      const result = await DBQuery(rpcConfig, conn.dbName, compileSQL);
      if (!result.success) {
        message.error(t('sidebar.message.object_compile_failed', {
          type: objectLabel,
          name: objectName,
          error: result.message || t('common.unknown'),
        }));
        return;
      }
      const compileErrors = await loadOracleCompileErrors([compileTarget], {
        query: (sql) => DBQuery(rpcConfig, conn.dbName, sql),
      });
      if (compileErrors.length > 0) {
        message.error(t('sidebar.message.object_compile_failed', {
          type: objectLabel,
          name: objectName,
          error: formatOracleCompileErrors(compileErrors),
        }));
      } else {
        message.success(t('sidebar.message.object_compile_success', {
          type: objectLabel,
          name: objectName,
        }));
      }
      await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
    } catch (error: any) {
      message.error(t('sidebar.message.object_compile_failed', {
        type: objectLabel,
        name: objectName,
        error: error?.message || String(error),
      }));
    }
  };
  return {
    openRoutineDefinition, openEventDefinition, openEditEvent, openSequenceDefinition,
    openPackageDefinition, openEditRoutine, openCreateRoutine, handleDropRoutine,
    handleCompileOracleObject,
  };
};

export type SidebarRoutineActionsApi = ReturnType<typeof useSidebarRoutineActions>;
