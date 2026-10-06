import { DBGetColumns, DBGetIndexes } from '../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from './connectionRpcConfig';
import { resolveDataSourceType } from './dataSourceCapabilities';
import { requestTableMetadata } from './tableMetadataRequestCache';

/**
 * Starts the metadata requests a table tab makes first, at the moment the user
 * opens the table. The tab shares them instead of starting its own once it has
 * mounted, so its content does not wait for the page to render first.
 *
 * Only requests the tab would send anyway are started; nothing is loaded on a
 * guess.
 */
export const prefetchTableOpenMetadata = (input: {
    connection: { config?: Record<string, any> } | undefined;
    connectionId: string;
    dbName: string;
    tableName: string;
    /** 'fields' opens the structure designer, 'data' the row grid. */
    view: 'data' | 'fields';
}): void => {
    const connectionConfig = input.connection?.config;
    const tableName = String(input.tableName || '').trim();
    if (!connectionConfig || !tableName) return;
    const dbName = String(input.dbName || '');
    // Kingbase 的数据视图先发分页查询、之后才取定位信息；预取会排到分页查询前面，反而拖慢它。
    if (input.view === 'data' && resolveDataSourceType(connectionConfig as any) === 'kingbase') return;

    const rpcConfig = buildRpcConnectionConfig({
        ...connectionConfig,
        port: Number(connectionConfig.port),
        password: connectionConfig.password || '',
        database: connectionConfig.database || '',
        useSSH: connectionConfig.useSSH || false,
        ssh: connectionConfig.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    } as any) as any;
    const key = { connectionId: input.connectionId, dbName, tableName };
    void requestTableMetadata({ ...key, kind: 'columns' }, () => DBGetColumns(rpcConfig, dbName, tableName))
        .catch(() => undefined);
    if (input.view === 'data') {
        // The row grid waits for columns and indexes before it can build its first query.
        void requestTableMetadata({ ...key, kind: 'indexes' }, () => DBGetIndexes(rpcConfig, dbName, tableName))
            .catch(() => undefined);
    }
};
