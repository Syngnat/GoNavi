import { DBGetColumns } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { requestTableMetadata } from '../../utils/tableMetadataRequestCache';

/**
 * Starts loading the columns of a table the user just Ctrl/Cmd+clicked. The
 * table tab that opens next shares this request instead of starting its own
 * after mounting, so its fields are there as soon as it shows.
 *
 * Resolves to true when the table returned columns, which also proves that it
 * exists; false tells the caller nothing.
 */
export const prefetchQueryEditorNavigationTableColumns = (
    connection: { config?: Record<string, any> } | undefined,
    connectionId: string,
    dbName: string,
    tableName: string,
): Promise<boolean> => {
    const connectionConfig = connection?.config;
    if (!connectionConfig || !String(tableName || '').trim()) {
        return Promise.resolve(false);
    }
    const config = {
        ...connectionConfig,
        port: Number(connectionConfig.port),
        password: connectionConfig.password || '',
        database: connectionConfig.database || '',
        useSSH: connectionConfig.useSSH || false,
        ssh: connectionConfig.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    };
    return requestTableMetadata(
        { connectionId, dbName, tableName, kind: 'columns' },
        () => DBGetColumns(buildRpcConnectionConfig(config) as any, dbName, tableName),
    ).then(
        (result: any) => Boolean(result?.success && Array.isArray(result.data) && result.data.length > 0),
        () => false,
    );
};
