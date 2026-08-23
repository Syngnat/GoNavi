export type TableMetadataRequestKind = 'columns' | 'indexes' | 'foreignKeys';

export type TableMetadataRequestKey = {
  connectionId: string;
  dbName: string;
  tableName: string;
  kind: TableMetadataRequestKind;
  connectionParams?: string;
};

type TableMetadataRequestOptions = {
  force?: boolean;
};

type TableMetadataRequestEntry<T = unknown> = {
  promise: Promise<T>;
  settledAt?: number;
};

const TABLE_METADATA_RESULT_TTL_MS = 5_000;
const MAX_TABLE_METADATA_REQUESTS = 128;
const tableMetadataRequests = new Map<string, TableMetadataRequestEntry>();

const serializeTableMetadataRequestKey = (key: TableMetadataRequestKey): string => JSON.stringify([
  String(key.kind || '').trim(),
  String(key.connectionId || '').trim(),
  String(key.dbName || '').trim(),
  String(key.tableName || '').trim(),
  String(key.connectionParams || ''),
]);

const pruneTableMetadataRequests = (now: number) => {
  tableMetadataRequests.forEach((entry, key) => {
    if (entry.settledAt !== undefined && now - entry.settledAt > TABLE_METADATA_RESULT_TTL_MS) {
      tableMetadataRequests.delete(key);
    }
  });

  while (tableMetadataRequests.size >= MAX_TABLE_METADATA_REQUESTS) {
    const oldestKey = tableMetadataRequests.keys().next().value;
    if (oldestKey === undefined) break;
    tableMetadataRequests.delete(oldestKey);
  }
};

export const requestTableMetadata = <T>(
  key: TableMetadataRequestKey,
  loader: () => Promise<T>,
  options: TableMetadataRequestOptions = {},
): Promise<T> => {
  const serializedKey = serializeTableMetadataRequestKey(key);
  const now = Date.now();
  const cached = tableMetadataRequests.get(serializedKey) as TableMetadataRequestEntry<T> | undefined;

  if (!options.force && cached) {
    if (cached.settledAt === undefined || now - cached.settledAt <= TABLE_METADATA_RESULT_TTL_MS) {
      return cached.promise;
    }
    tableMetadataRequests.delete(serializedKey);
  }

  pruneTableMetadataRequests(now);

  let promise: Promise<T>;
  try {
    promise = Promise.resolve(loader());
  } catch (error) {
    promise = Promise.reject(error);
  }

  const entry: TableMetadataRequestEntry<T> = { promise };
  tableMetadataRequests.set(serializedKey, entry);
  void promise.then(
    () => {
      if (tableMetadataRequests.get(serializedKey) === entry) {
        entry.settledAt = Date.now();
      }
    },
    () => {
      if (tableMetadataRequests.get(serializedKey) === entry) {
        tableMetadataRequests.delete(serializedKey);
      }
    },
  );

  return promise;
};

export const resetTableMetadataRequestCacheForTests = () => {
  tableMetadataRequests.clear();
};
