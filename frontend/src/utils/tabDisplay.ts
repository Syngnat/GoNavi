import type { ConnectionConfig, SavedConnection, TabData } from '../types';
import { t as catalogTranslate } from '../i18n/catalog';
import type { I18nParams } from '../i18n/types';
import { resolveLocalizedUntitledQueryTitle } from './queryTabTitle';

export const TAB_DISPLAY_ELEMENT_KEYS = ['object', 'kind', 'connection', 'database', 'schema', 'host'] as const;

export type TabDisplayElementKey = typeof TAB_DISPLAY_ELEMENT_KEYS[number];
export type TabDisplayLayout = 'single' | 'double';

export interface TabDisplayLayoutSnapshot {
  primaryElements: TabDisplayElementKey[];
  secondaryElements: TabDisplayElementKey[];
}

export interface TabDisplaySettings {
  layout: TabDisplayLayout;
  primaryElements: TabDisplayElementKey[];
  secondaryElements: TabDisplayElementKey[];
  single?: TabDisplayLayoutSnapshot;
  double?: TabDisplayLayoutSnapshot;
}

export type TabDisplayTranslate = (key: string, params?: I18nParams) => string;

const defaultTranslate: TabDisplayTranslate = (key, params) => catalogTranslate('en-US', key, params);

export const TAB_DISPLAY_SECONDARY_DEFAULT_KEYS: TabDisplayElementKey[] = ['kind', 'connection', 'database', 'schema', 'host'];

export const TAB_DISPLAY_ELEMENT_META: Record<TabDisplayElementKey, { labelKey: string; descriptionKey: string }> = {
  connection: {
    labelKey: 'app.theme.tab_display.element.connection.label',
    descriptionKey: 'app.theme.tab_display.element.connection.description',
  },
  kind: {
    labelKey: 'app.theme.tab_display.element.kind.label',
    descriptionKey: 'app.theme.tab_display.element.kind.description',
  },
  object: {
    labelKey: 'app.theme.tab_display.element.object.label',
    descriptionKey: 'app.theme.tab_display.element.object.description',
  },
  database: {
    labelKey: 'app.theme.tab_display.element.database.label',
    descriptionKey: 'app.theme.tab_display.element.database.description',
  },
  schema: {
    labelKey: 'app.theme.tab_display.element.schema.label',
    descriptionKey: 'app.theme.tab_display.element.schema.description',
  },
  host: {
    labelKey: 'app.theme.tab_display.element.host.label',
    descriptionKey: 'app.theme.tab_display.element.host.description',
  },
};

const DEFAULT_SINGLE_TAB_DISPLAY_SNAPSHOT: TabDisplayLayoutSnapshot = {
  primaryElements: ['connection', 'kind', 'object'],
  secondaryElements: [],
};

const DEFAULT_DOUBLE_TAB_DISPLAY_SNAPSHOT: TabDisplayLayoutSnapshot = {
  primaryElements: ['object'],
  secondaryElements: ['kind', 'connection', 'database'],
};

export const DEFAULT_TAB_DISPLAY_SETTINGS: TabDisplaySettings = {
  layout: 'double',
  primaryElements: [...DEFAULT_DOUBLE_TAB_DISPLAY_SNAPSHOT.primaryElements],
  secondaryElements: [...DEFAULT_DOUBLE_TAB_DISPLAY_SNAPSHOT.secondaryElements],
};

export const getCurrentTabDisplaySnapshot = (settings: TabDisplaySettings): TabDisplayLayoutSnapshot => ({
  primaryElements: [...settings.primaryElements],
  secondaryElements: [...settings.secondaryElements],
});

export const getDefaultTabDisplaySnapshot = (layout: TabDisplayLayout): TabDisplayLayoutSnapshot => {
  const snapshot = layout === 'single'
    ? DEFAULT_SINGLE_TAB_DISPLAY_SNAPSHOT
    : DEFAULT_DOUBLE_TAB_DISPLAY_SNAPSHOT;
  return {
    primaryElements: [...snapshot.primaryElements],
    secondaryElements: [...snapshot.secondaryElements],
  };
};

export const getSavedTabDisplaySnapshot = (
  settings: TabDisplaySettings,
  layout: TabDisplayLayout,
): TabDisplayLayoutSnapshot => {
  const saved = settings[layout];
  if (saved) {
    return {
      primaryElements: [...saved.primaryElements],
      secondaryElements: [...saved.secondaryElements],
    };
  }
  if (settings.layout === layout) {
    return getCurrentTabDisplaySnapshot(settings);
  }
  return getDefaultTabDisplaySnapshot(layout);
};

export const applyTabDisplaySettingsPatch = (
  currentSettings: TabDisplaySettings,
  patch: Partial<TabDisplaySettings>,
): TabDisplaySettings => {
  const nextSettings = sanitizeTabDisplaySettings({
    ...currentSettings,
    ...patch,
  });
  const nextSnapshot = getCurrentTabDisplaySnapshot(nextSettings);
  return sanitizeTabDisplaySettings({
    ...nextSettings,
    [nextSettings.layout]: nextSnapshot,
  });
};

export const switchTabDisplayLayout = (
  currentSettings: TabDisplaySettings,
  layout: TabDisplayLayout,
): TabDisplaySettings => {
  if (layout === currentSettings.layout) {
    return sanitizeTabDisplaySettings(currentSettings);
  }
  const currentSnapshot = getCurrentTabDisplaySnapshot(currentSettings);
  const targetSnapshot = getSavedTabDisplaySnapshot(currentSettings, layout);
  return sanitizeTabDisplaySettings({
    ...currentSettings,
    [currentSettings.layout]: currentSnapshot,
    layout,
    primaryElements: targetSnapshot.primaryElements,
    secondaryElements: targetSnapshot.secondaryElements,
    [layout]: targetSnapshot,
  });
};

const isTabDisplayElementKey = (value: unknown): value is TabDisplayElementKey => (
  typeof value === 'string' && (TAB_DISPLAY_ELEMENT_KEYS as readonly string[]).includes(value)
);

const sanitizeTabDisplayElementList = (
  value: unknown,
  used: Set<TabDisplayElementKey>,
): TabDisplayElementKey[] => {
  if (!Array.isArray(value)) return [];
  const result: TabDisplayElementKey[] = [];
  value.forEach((entry) => {
    if (!isTabDisplayElementKey(entry) || used.has(entry)) return;
    used.add(entry);
    result.push(entry);
  });
  return result;
};

const sanitizeTabDisplayLayoutSnapshot = (
  value: unknown,
  layout: TabDisplayLayout,
): TabDisplayLayoutSnapshot | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<TabDisplayLayoutSnapshot>;
  const used = new Set<TabDisplayElementKey>();
  const primaryElements = sanitizeTabDisplayElementList(raw.primaryElements, used);
  const secondaryElements = sanitizeTabDisplayElementList(raw.secondaryElements, used);
  const fallback = getDefaultTabDisplaySnapshot(layout);
  return {
    primaryElements: primaryElements.length > 0 ? primaryElements : fallback.primaryElements,
    secondaryElements,
  };
};

export const sanitizeTabDisplaySettings = (value: unknown): TabDisplaySettings => {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_TAB_DISPLAY_SETTINGS, primaryElements: [...DEFAULT_TAB_DISPLAY_SETTINGS.primaryElements], secondaryElements: [...DEFAULT_TAB_DISPLAY_SETTINGS.secondaryElements] };
  }
  const raw = value as Partial<TabDisplaySettings>;
  const layout = raw.layout === 'single' || raw.layout === 'double'
    ? raw.layout
    : DEFAULT_TAB_DISPLAY_SETTINGS.layout;
  const fallback = getDefaultTabDisplaySnapshot(layout);
  const used = new Set<TabDisplayElementKey>();
  const primaryElements = sanitizeTabDisplayElementList(raw.primaryElements, used);
  const secondaryElements = sanitizeTabDisplayElementList(raw.secondaryElements, used);
  const result: TabDisplaySettings = {
    layout,
    primaryElements: primaryElements.length > 0 ? primaryElements : fallback.primaryElements,
    secondaryElements,
  };
  const single = sanitizeTabDisplayLayoutSnapshot(raw.single, 'single');
  const double = sanitizeTabDisplayLayoutSnapshot(raw.double, 'double');
  if (single) {
    result.single = single;
  }
  if (double) {
    result.double = double;
  }
  return result;
};

export const resolveTabDisplayElementOrder = (settings?: Partial<TabDisplaySettings> | null): TabDisplayElementKey[] => {
  const sanitized = sanitizeTabDisplaySettings(settings);
  const visible = [...sanitized.primaryElements, ...sanitized.secondaryElements];
  return [
    ...visible,
    ...TAB_DISPLAY_ELEMENT_KEYS.filter((key) => !visible.includes(key)),
  ];
};

export const detectConnectionEnvLabel = (connectionName: string): string | null => {
  const tokens = connectionName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes('prod') || tokens.includes('production')) return 'PROD';
  if (tokens.includes('uat')) return 'UAT';
  if (tokens.includes('dev') || tokens.includes('development')) return 'DEV';
  if (tokens.includes('sit')) return 'SIT';
  if (tokens.includes('stg') || tokens.includes('stage') || tokens.includes('staging') || tokens.includes('pre')) return 'STG';
  if (tokens.includes('test') || tokens.includes('qa')) return 'TEST';
  return null;
};

const parseHostOnlyToken = (value: unknown): string[] => {
  const raw = String(value || '').trim();
  if (!raw) {
    return [];
  }

  let text = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (text.includes('/')) {
    text = text.split('/')[0];
  }
  if (text.includes('?')) {
    text = text.split('?')[0];
  }
  if (text.includes('@')) {
    text = text.split('@').pop() || '';
  }

  return text
    .split(',')
    .map((entry) => {
      const token = entry.trim();
      if (!token) return '';
      if (token.startsWith('[')) {
        const rightBracketIndex = token.indexOf(']');
        if (rightBracketIndex > 0) {
          return token.slice(0, rightBracketIndex + 1).toLowerCase();
        }
      }
      const colonIndex = token.lastIndexOf(':');
      if (colonIndex > 0) {
        return token.slice(0, colonIndex).toLowerCase();
      }
      return token.toLowerCase();
    })
    .filter(Boolean);
};

export const resolveConnectionHostTokens = (config?: ConnectionConfig): string[] => {
  if (!config) {
    return [];
  }

  return Array.from(new Set([
    ...parseHostOnlyToken(config.host),
    ...(Array.isArray(config.hosts) ? config.hosts.flatMap((entry) => parseHostOnlyToken(entry)) : []),
    ...parseHostOnlyToken(config.uri),
  ]));
};

export const resolveConnectionHostSummary = (config?: ConnectionConfig): string => {
  const hosts = resolveConnectionHostTokens(config);
  if (hosts.length === 0) return '';
  if (hosts.length === 1) return hosts[0];
  return `${hosts[0]} +${hosts.length - 1}`;
};

const isRedisTab = (tab: TabData): boolean => {
  return tab.type === 'redis-keys' || tab.type === 'redis-command' || tab.type === 'redis-monitor';
};

const isNacosTab = (tab: TabData): boolean =>
  tab.type === 'nacos-config' || tab.type === 'nacos-services';

const buildRedisBaseTitle = (tab: TabData, translate: TabDisplayTranslate = defaultTranslate): string => {
  const dbLabel = `db${tab.redisDB ?? 0}`;
  if (tab.type === 'redis-command') return translate('sidebar.tab.redis_command', { database: dbLabel });
  if (tab.type === 'redis-monitor') return translate('sidebar.tab.redis_monitor', { database: dbLabel });
  return dbLabel;
};

const splitQualifiedIdentifier = (value: unknown): string[] => {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const parts: string[] = [];
  let current = '';
  let quote: '"' | '`' | '[' | null = null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (char === '\\' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (quote === '"') {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (quote === '`') {
      current += char;
      if (char === '`' && next === '`') {
        current += next;
        index += 1;
      } else if (char === '`') {
        quote = null;
      }
      continue;
    }

    if (quote === '[') {
      current += char;
      if (char === ']') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '`' || char === '[') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts.filter(Boolean);
};

const unwrapIdentifierLabel = (value: string): string => {
  let text = String(value || '').trim().replace(/\\"/g, '"');
  if (!text) return '';

  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
    text = text.slice(1, -1);
  } else if (first === '[' && last === ']') {
    text = text.slice(1, -1);
  }

  return text
    .replace(/""/g, '"')
    .replace(/``/g, '`')
    .replace(/\]\]/g, ']')
    .trim();
};

export const stripSchemaFromTabObjectLabel = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const parts = splitQualifiedIdentifier(raw);
  const lastPart = parts[parts.length - 1] || raw;
  return unwrapIdentifierLabel(lastPart) || raw;
};

const getSchemaFromTabObjectLabel = (value: unknown): string => {
  const parts = splitQualifiedIdentifier(value);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).map((part) => unwrapIdentifierLabel(part)).filter(Boolean).join('.');
};

const replaceTitleObjectLabel = (title: string, objectName?: string): string => {
  const rawTitle = String(title || '').trim();
  if (!rawTitle) return rawTitle;

  const rawObjectName = String(objectName || '').trim();
  const displayObjectName = stripSchemaFromTabObjectLabel(rawObjectName);
  if (rawObjectName && displayObjectName && displayObjectName !== rawObjectName) {
    const lastIndex = rawTitle.lastIndexOf(rawObjectName);
    if (lastIndex >= 0) {
      return `${rawTitle.slice(0, lastIndex)}${displayObjectName}${rawTitle.slice(lastIndex + rawObjectName.length)}`;
    }
  }

  const parenMatch = rawTitle.match(/^(.*\()([^()]*)\)(\s*)$/);
  if (parenMatch) {
    const objectLabel = stripSchemaFromTabObjectLabel(parenMatch[2]);
    return `${parenMatch[1]}${objectLabel})${parenMatch[3]}`;
  }

  const colonMatch = rawTitle.match(/^([^:：]+[:：]\s*)(.+)$/);
  if (colonMatch) {
    return `${colonMatch[1]}${stripSchemaFromTabObjectLabel(colonMatch[2])}`;
  }

  return stripSchemaFromTabObjectLabel(rawTitle);
};

const stripSchemaFromTableOverviewTitle = (title: string): string => {
  const rawTitle = String(title || '').trim();
  return rawTitle.replace(/\s+\([^()]+\)\s*$/, '').trim() || rawTitle;
};

const QUERY_TAB_TITLE_MAX_LENGTH = 28;

const getFileNameFromPath = (value: string): string => (
  value.split(/[\\/]/).filter(Boolean).pop() || value
);

const isLikelyRawSqlTitle = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  if (/[\r\n;]/.test(text)) return true;
  return /^(select|with|insert|update|delete|merge|create|alter|drop|truncate|explain|show|desc|describe)\b/i.test(text);
};

const compactQueryTabTitle = (tab: TabData, translate: TabDisplayTranslate = defaultTranslate): string => {
  const filePath = String(tab.filePath || '').trim();
  if (filePath) {
    return getFileNameFromPath(filePath);
  }

  const rawTitle = String(tab.title || '').trim();
  const resolvedUntitledTitle = resolveLocalizedUntitledQueryTitle(rawTitle, tab.dbName, translate);
  const displayTitle = resolvedUntitledTitle || rawTitle;
  const title = displayTitle && !isLikelyRawSqlTitle(displayTitle) ? displayTitle : translate('sidebar.tab.new_query');
  if (title.length <= QUERY_TAB_TITLE_MAX_LENGTH) {
    return title;
  }
  return `${title.slice(0, QUERY_TAB_TITLE_MAX_LENGTH - 3)}...`;
};

const buildCompactObjectTabTitle = (tab: TabData, translate: TabDisplayTranslate = defaultTranslate): string => {
  if (tab.type === 'query') {
    return compactQueryTabTitle(tab, translate);
  }
  if (tab.type === 'table') {
    return stripSchemaFromTabObjectLabel(tab.tableName || tab.title) || tab.title;
  }
  if (tab.type === 'design') {
    return replaceTitleObjectLabel(tab.title, tab.tableName);
  }
  if (tab.type === 'table-overview') {
    return stripSchemaFromTableOverviewTitle(tab.title);
  }
  if (tab.type === 'table-export') {
    return replaceTitleObjectLabel(tab.title, tab.tableName);
  }
  if (tab.type === 'data-import') {
    return replaceTitleObjectLabel(tab.title, tab.tableName);
  }
  if (tab.type === 'view-def') {
    return replaceTitleObjectLabel(tab.title, tab.viewName);
  }
  if (tab.type === 'trigger') {
    return replaceTitleObjectLabel(tab.title, tab.triggerName);
  }
  if (tab.type === 'event-def') {
    return replaceTitleObjectLabel(tab.title, tab.eventName);
  }
  if (tab.type === 'routine-def') {
    return replaceTitleObjectLabel(tab.title, tab.routineName);
  }
  if (tab.type === 'sequence-def') {
    return replaceTitleObjectLabel(tab.title, tab.sequenceName);
  }
  if (tab.type === 'package-def') {
    return replaceTitleObjectLabel(tab.title, tab.packageName);
  }
  return tab.title;
};

export const getTabDisplayKindLabel = (tab: TabData): string => {
  if (tab.type === 'query') return 'SQL';
  if (tab.type === 'table') return 'TABLE';
  if (tab.type === 'design') return 'DESIGN';
  if (tab.type === 'table-overview') return 'DB';
  if (tab.type === 'table-export') return 'EXPORT';
  if (tab.type === 'data-import') return 'IMPORT';
  if (tab.type === 'data-sync') return 'SYNC';
  if (tab.type === 'sql-analysis') return 'ANALYZE';
  if (tab.type === 'sql-audit') return 'AUDIT';
  if (tab.type.startsWith('redis')) return 'REDIS';
  if (tab.type.startsWith('jvm')) return 'JVM';
  if (tab.type === 'trigger') return 'TRG';
  if (tab.type === 'view-def') return tab.viewKind === 'materialized' ? 'MV' : 'VIEW';
  if (tab.type === 'event-def') return 'EVT';
  if (tab.type === 'routine-def') return 'FUNC';
  if (tab.type === 'sequence-def') return 'SEQ';
  if (tab.type === 'package-def') return 'PKG';
  return 'TAB';
};

const getTabRawObjectLabel = (tab: TabData, translate: TabDisplayTranslate = defaultTranslate): string => {
  if (tab.type === 'query') return compactQueryTabTitle(tab, translate);
  if (tab.tableName) return tab.tableName;
  if (tab.viewName) return tab.viewName;
  if (tab.eventName) return tab.eventName;
  if (tab.routineName) return tab.routineName;
  if (tab.sequenceName) return tab.sequenceName;
  if (tab.packageName) return tab.packageName;
  if (tab.triggerName) return tab.triggerName;
  if (tab.resourcePath) return tab.resourcePath;
  if (tab.filePath) return getFileNameFromPath(tab.filePath);
  if (tab.type.startsWith('redis')) return `db${tab.redisDB ?? 0}`;
  if (tab.type === 'sql-audit') return tab.title;
  return tab.title;
};

const getTabConnectionLabel = (connection?: SavedConnection): string => {
  const connectionName = String(connection?.name || '').trim();
  return detectConnectionEnvLabel(connectionName) || connectionName;
};

const getTabDisplayElementValue = (
  key: TabDisplayElementKey,
  tab: TabData,
  connection?: SavedConnection,
  translate: TabDisplayTranslate = defaultTranslate,
): string => {
  const rawObjectLabel = getTabRawObjectLabel(tab, translate);
  switch (key) {
    case 'connection':
      return getTabConnectionLabel(connection);
    case 'kind':
      return getTabDisplayKindLabel(tab);
    case 'object':
      return buildCompactObjectTabTitle({
        ...tab,
        title: tab.type === 'table' || tab.type === 'query' ? rawObjectLabel : tab.title,
      }, translate);
    case 'database':
      return String(tab.dbName || '').trim();
    case 'schema':
      return String(tab.schemaName || '').trim() || getSchemaFromTabObjectLabel(rawObjectLabel);
    case 'host':
      return resolveConnectionHostSummary(connection?.config);
    default:
      return '';
  }
};

const formatTabDisplayPartValue = (key: TabDisplayElementKey, value: string): string => {
  if (!value) return '';
  if (key === 'connection') return `[${value}]`;
  if (key === 'schema') return `SCHEMA:${value}`;
  return value;
};

export interface TabDisplayPart {
  key: TabDisplayElementKey;
  value: string;
  text: string;
}

export interface TabDisplayModel {
  layout: TabDisplayLayout;
  primaryParts: TabDisplayPart[];
  secondaryParts: TabDisplayPart[];
  primaryText: string;
  secondaryText: string;
  fullTitle: string;
}

const buildTabDisplayParts = (
  keys: TabDisplayElementKey[],
  tab: TabData,
  connection?: SavedConnection,
  translate: TabDisplayTranslate = defaultTranslate,
): TabDisplayPart[] => keys
  .map((key) => {
    const value = getTabDisplayElementValue(key, tab, connection, translate);
    return {
      key,
      value,
      text: formatTabDisplayPartValue(key, value),
    };
  })
  .filter((part) => part.text);

export const buildTabDisplayModel = (
  tab: TabData,
  connection?: SavedConnection,
  settings?: Partial<TabDisplaySettings> | null,
  translate: TabDisplayTranslate = defaultTranslate,
): TabDisplayModel => {
  const sanitized = sanitizeTabDisplaySettings(settings);
  const primaryParts = buildTabDisplayParts(sanitized.primaryElements, tab, connection, translate);
  const secondaryParts = buildTabDisplayParts(sanitized.secondaryElements, tab, connection, translate);
  const primaryText = primaryParts.map((part) => part.text).join(' ').trim() || buildCompactObjectTabTitle(tab, translate);
  const secondaryText = secondaryParts.map((part) => part.text).join('·').trim();
  const fullTitle = [primaryText, secondaryText].filter(Boolean).join(' · ');
  return {
    layout: sanitized.layout,
    primaryParts,
    secondaryParts,
    primaryText,
    secondaryText,
    fullTitle,
  };
};

export const buildTabDisplayTitle = (
  tab: TabData,
  connection?: SavedConnection,
  settings?: Partial<TabDisplaySettings> | null,
  translate: TabDisplayTranslate = defaultTranslate,
): string => {
  if (settings) {
    return buildTabDisplayModel(tab, connection, settings, translate).fullTitle;
  }

  const connectionName = String(connection?.name || '').trim();

  if (isRedisTab(tab)) {
    const hostSummary = resolveConnectionHostSummary(connection?.config);
    const identity = [connectionName, hostSummary].filter(Boolean).join(' | ');
    return identity ? `[${identity}] ${buildRedisBaseTitle(tab, translate)}` : buildRedisBaseTitle(tab, translate);
  }

  if (isNacosTab(tab)) {
    const nsTitle = String(tab.nacosNamespaceName || tab.nacosNamespaceId || tab.title || 'public').trim();
    const kind = tab.type === 'nacos-services' ? 'services' : 'config';
    const full = `${nsTitle} · ${kind}`;
    return connectionName ? `[${connectionName}] ${full}` : full;
  }

  const baseTitle = buildCompactObjectTabTitle(tab, translate);
  if (
    tab.type !== 'table' &&
    tab.type !== 'design' &&
    tab.type !== 'table-overview' &&
    tab.type !== 'table-export' &&
    tab.type !== 'data-import' &&
    tab.type !== 'sql-analysis'
  ) {
    return baseTitle;
  }
  if (!connectionName) {
    return baseTitle;
  }

  const prefix = detectConnectionEnvLabel(connectionName) || connectionName;
  return `[${prefix}] ${baseTitle}`;
};
