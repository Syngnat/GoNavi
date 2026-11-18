import { DBQuery, DBShowCreateTable } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import {
  buildQueryEditorViewDefinitionQueries,
  extractQueryEditorViewDefinition,
} from '../queryEditor/queryEditorObjectDefinitionQueries';
import { normalizeMySQLViewDDLForEditing } from '../sidebarCoreUtils';

export type SidebarViewDefinitionSource = 'driver' | 'query' | 'none';

export type SidebarViewDefinitionResult = {
  definition: string;
  source: SidebarViewDefinitionSource;
};

export type LoadSidebarViewDefinitionInput = {
  connectionConfig: Record<string, unknown>;
  dbName: string;
  viewName: string;
  schemaName?: string;
  dialect: string;
  viewKind?: 'view' | 'materialized';
};

const firstSqlStatementText = (sql: string): string => {
  const meaningfulLines = String(sql || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'));
  return meaningfulLines.join('\n').trim();
};

export const looksLikeViewDefinition = (rawDefinition: unknown): boolean => {
  const sql = firstSqlStatementText(String(rawDefinition || ''));
  if (!sql) return false;
  if (/^(select|with|view)\b/i.test(sql)) return true;
  if (!/^(create|alter)\b/i.test(sql)) return false;
  const beforeAs = sql.split(/\bAS\b/i)[0] || sql;
  return /\bVIEW\b/i.test(beforeAs);
};

const ensureStatementTerminator = (sql: string): string => {
  const trimmed = String(sql || '').trim();
  if (!trimmed) return '';
  if (/;\s*$/.test(trimmed) || /(?:^|\n)\s*\/\s*$/.test(trimmed)) return trimmed;
  return `${trimmed};`;
};

export const normalizeSidebarViewDefinitionForEditing = (
  dialect: string,
  viewName: string,
  rawDefinition: unknown,
): string => {
  const text = String(rawDefinition || '').trim();
  if (!text) return '';
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!looksLikeViewDefinition(normalized)) return '';

  if (/^\s*view\b/i.test(normalized)) {
    return ensureStatementTerminator(normalized.replace(/^\s*view\b/i, 'CREATE OR REPLACE VIEW'));
  }

  if (/^\s*(select|with)\b/i.test(normalized)) {
    const createPrefix = dialect === 'sqlserver' || dialect === 'sqlite'
      ? 'CREATE VIEW'
      : 'CREATE OR REPLACE VIEW';
    return ensureStatementTerminator(`${createPrefix} ${viewName} AS\n${normalized}`);
  }

  if (dialect === 'mysql' || dialect === 'starrocks') {
    const mysqlDefinition = normalizeMySQLViewDDLForEditing(viewName, normalized);
    if (mysqlDefinition) return mysqlDefinition;
  }

  return ensureStatementTerminator(normalized);
};

const runViewDefinitionQueryFallback = async (
  input: LoadSidebarViewDefinitionInput,
  rpcConfig: ReturnType<typeof buildRpcConnectionConfig>,
): Promise<string> => {
  const queries = buildQueryEditorViewDefinitionQueries(
    input.dialect,
    input.viewName,
    input.dbName,
    input.schemaName,
    input.viewKind,
  );
  for (const query of queries) {
    const sql = String(query || '').trim();
    if (!sql || sql.startsWith('--')) continue;
    try {
      const result = await DBQuery(rpcConfig as any, input.dbName, sql);
      if (!result.success || !Array.isArray(result.data) || result.data.length === 0) continue;
      const rawDefinition = extractQueryEditorViewDefinition(input.dialect, result.data);
      const definition = normalizeSidebarViewDefinitionForEditing(
        input.dialect,
        input.viewName,
        rawDefinition,
      );
      if (definition) return definition;
    } catch {
      // 继续尝试下一种方言查询；最终由调用方决定是否提示。
    }
  }
  return '';
};

export const loadSidebarViewDefinitionForEditing = async (
  input: LoadSidebarViewDefinitionInput,
): Promise<SidebarViewDefinitionResult> => {
  const rpcConfig = buildRpcConnectionConfig(input.connectionConfig);

  try {
    const result = await DBShowCreateTable(rpcConfig as any, input.dbName, input.viewName);
    const rawDefinition = result.success ? String(result.data || '').trim() : '';
    const definition = normalizeSidebarViewDefinitionForEditing(
      input.dialect,
      input.viewName,
      rawDefinition,
    );
    if (definition) {
      return { definition, source: 'driver' };
    }
  } catch {
    // 驱动没有视图 DDL 能力时，继续走方言查询。
  }

  const definition = await runViewDefinitionQueryFallback(input, rpcConfig);
  return definition
    ? { definition, source: 'query' }
    : { definition: '', source: 'none' };
};
