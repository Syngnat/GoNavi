import { resolveOceanBaseProtocolFromConfig } from '../utils/oceanBaseProtocol';

type DataSyncDatabaseConfig = {
  type?: unknown;
  driver?: unknown;
  database?: unknown;
  user?: unknown;
  redisDB?: unknown;
  oceanBaseProtocol?: unknown;
  connectionParams?: unknown;
  uri?: unknown;
};

export type DataSyncDatabaseSelection = {
  options: string[];
  preferred: string;
};

const METADATA_NAME_KEYS = ['database', 'username', 'name', 'catalog', 'schema'];

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const readMetadataName = (row: unknown): string => {
  if (typeof row === 'string') {
    return row.trim();
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return '';
  }

  const values = new Map<string, unknown>();
  Object.entries(row as Record<string, unknown>).forEach(([key, value]) => {
    values.set(key.toLowerCase(), value);
  });
  for (const key of METADATA_NAME_KEYS) {
    const value = normalizeText(values.get(key));
    if (value) {
      return value;
    }
  }
  return '';
};

const resolveConfiguredDatabase = (config: DataSyncDatabaseConfig): string => {
  const type = normalizeText(config.type || config.driver).toLowerCase();
  const isOracle = type === 'oracle';
  let isOceanBaseOracle = false;
  if (type === 'oceanbase') {
    try {
      isOceanBaseOracle = resolveOceanBaseProtocolFromConfig(
        config as Record<string, unknown>,
      ) === 'oracle';
    } catch {
      isOceanBaseOracle = false;
    }
  }
  if (isOracle || isOceanBaseOracle) {
    return normalizeText(config.user);
  }
  if (type === 'redis') {
    const configuredDatabase = normalizeText(config.database);
    return configuredDatabase || normalizeText(config.redisDB);
  }
  return normalizeText(config.database);
};

export const resolveDataSyncDatabaseSelection = (
  config: DataSyncDatabaseConfig,
  rows: unknown[],
): DataSyncDatabaseSelection => {
  const seen = new Set<string>();
  const options: string[] = [];
  rows.forEach((row) => {
    const name = readMetadataName(row);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push(name);
  });

  const configured = resolveConfiguredDatabase(config);
  if (options.length === 0) {
    return configured
      ? { options: [configured], preferred: configured }
      : { options: [], preferred: '' };
  }

  const configuredOption = configured
    ? options.find((option) => option.toLowerCase() === configured.toLowerCase())
    : undefined;
  return {
    options,
    preferred: configuredOption || (options.length === 1 ? options[0] : ''),
  };
};
