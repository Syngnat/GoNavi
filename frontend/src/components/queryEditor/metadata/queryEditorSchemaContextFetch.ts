import { DBQuery } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { loadSchemas } from '../../sidebar/sidebarMetadataLoaders';
import { QUERY_EDITOR_CURRENT_SCHEMA_SQL, extractQueryEditorCurrentSchema } from '../queryEditorSchemaContext';
import type { QueryEditorSchemaContext, QueryEditorSessionLoadResult } from './queryEditorSessionMetadataStore';

// Kept apart from the object-catalog fetch: the table designer shares this
// schema list with the query editor and must not pull the editor helpers in.

/** Loads the schema list of a database together with the schema the server resolves by default. */
export const fetchQueryEditorSchemaContext = async (
    conn: any,
    dbName: string,
): Promise<QueryEditorSessionLoadResult<QueryEditorSchemaContext>> => {
    const config = {
        ...conn.config,
        port: Number(conn.config.port),
        password: conn.config.password || '',
        database: conn.config.database || '',
        useSSH: conn.config.useSSH || false,
        ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    };
    let defaultSchemaLoaded = false;
    const loadCurrentSchema = DBQuery(
        buildRpcConnectionConfig(config) as any,
        dbName,
        QUERY_EDITOR_CURRENT_SCHEMA_SQL,
    ).then((result) => {
        if (!result.success) return '';
        defaultSchemaLoaded = true;
        return extractQueryEditorCurrentSchema(result.data);
    }).catch(() => '');

    const [result, defaultSchema] = await Promise.all([loadSchemas(conn, dbName, DBQuery, true), loadCurrentSchema]);
    const schemaNames = Array.isArray(result.schemas) ? result.schemas : [];
    return {
        value: { schemaNames, defaultSchema },
        // A transient failure must not pin an empty list or a guessed default schema for later tabs.
        cacheable: defaultSchemaLoaded && result.supported !== false && schemaNames.length > 0,
    };
};
