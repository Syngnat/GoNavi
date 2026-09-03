import { isPostgresSchemaDialect } from './connectionDriverType';

export type MetadataIdentityPart = string | null | undefined;

export type MetadataIdentityMode = 'postgres-schema' | 'folded';

export const getMetadataIdentityMode = (dialect: string): MetadataIdentityMode => (
  isPostgresSchemaDialect(dialect) ? 'postgres-schema' : 'folded'
);

export const normalizeMetadataIdentityPart = (
  dialect: string,
  value: MetadataIdentityPart,
): string => {
  const text = String(value ?? '').trim();
  return getMetadataIdentityMode(dialect) === 'postgres-schema'
    ? text
    : text.toLowerCase();
};

// Metadata values originate from the server catalog. PostgreSQL-compatible
// catalogs can contain distinct quoted identifiers such as "Users" and
// "users", so their catalog identity must preserve case. Other supported
// dialects retain the historical case-insensitive lookup behavior.
export const buildMetadataIdentityKey = (
  dialect: string,
  ...parts: MetadataIdentityPart[]
): string => parts
  .map((part) => normalizeMetadataIdentityPart(dialect, part))
  .join('\u0000');
