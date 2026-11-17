export type DataSyncEntryMode = 'sync' | 'compare';

/** 侧栏 Ctrl+C/Ctrl+V 粘贴表时传给数据同步工作台的预填端点。 */
export type DataSyncPasteEndpoint = {
  connectionId: string;
  database: string;
  schema?: string;
  table?: string;
  tables?: string[];
};

export type DataSyncPastePrefill = {
  source: DataSyncPasteEndpoint;
  target: DataSyncPasteEndpoint;
};

/** Legacy session/menu aliases that all map onto the compare workbench. */
export type DataSyncEntryModeAlias = DataSyncEntryMode | 'schemaCompare' | 'dataCompare';

export const normalizeDataSyncEntryMode = (
  entryMode?: string | null,
): DataSyncEntryMode =>
  entryMode === 'compare' ||
  entryMode === 'schemaCompare' ||
  entryMode === 'dataCompare'
    ? 'compare'
    : 'sync';

export type DataSyncEntryModePresentation = {
  title: string;
  description: string;
  heroTitle: string;
  heroDescription: string;
  optionTitle: string;
  tableSelectLabel: string;
  analyzeButtonText: string;
  closeButtonText: string;
  badgeText: string;
  resultTitle: string;
  readOnly: boolean;
};

type DataSyncEntryModeTranslator = (key: string) => string;

const text = (key: string, t?: DataSyncEntryModeTranslator) => (t ? t(key) : key);

export const resolveDataSyncEntryModePresentation = (
  entryMode: DataSyncEntryModeAlias,
  t?: DataSyncEntryModeTranslator,
): DataSyncEntryModePresentation => {
  switch (entryMode) {
    case 'compare':
      return {
        title: text('data_sync.entry_mode.compare.title', t),
        description: text('data_sync.entry_mode.compare.description', t),
        heroTitle: text('data_sync.entry_mode.compare.title', t),
        heroDescription: text('data_sync.entry_mode.compare.hero_description', t),
        optionTitle: text('data_sync.entry_mode.compare.option_title', t),
        tableSelectLabel: text('data_sync.entry_mode.compare.table_select_label', t),
        analyzeButtonText: text('data_sync.entry_mode.compare.action.start', t),
        closeButtonText: text('data_sync.action.close', t),
        badgeText: text('data_sync.entry_mode.compare.badge', t),
        resultTitle: text('data_sync.entry_mode.compare.result_title', t),
        readOnly: true,
      };
    case 'schemaCompare':
      return {
        title: text('data_sync.entry_mode.schema_compare.title', t),
        description: text('data_sync.entry_mode.schema_compare.description', t),
        heroTitle: text('data_sync.entry_mode.schema_compare.title', t),
        heroDescription: text('data_sync.entry_mode.schema_compare.hero_description', t),
        optionTitle: text('data_sync.entry_mode.compare.option_title', t),
        tableSelectLabel: text('data_sync.entry_mode.schema_compare.table_select_label', t),
        analyzeButtonText: text('data_sync.entry_mode.compare.action.start', t),
        closeButtonText: text('data_sync.action.close', t),
        badgeText: text('data_sync.entry_mode.schema_compare.badge', t),
        resultTitle: text('data_sync.entry_mode.compare.result_title', t),
        readOnly: true,
      };
    case 'dataCompare':
      return {
        title: text('data_sync.entry_mode.data_compare.title', t),
        description: text('data_sync.entry_mode.data_compare.description', t),
        heroTitle: text('data_sync.entry_mode.data_compare.title', t),
        heroDescription: text('data_sync.entry_mode.data_compare.hero_description', t),
        optionTitle: text('data_sync.entry_mode.compare.option_title', t),
        tableSelectLabel: text('data_sync.entry_mode.data_compare.table_select_label', t),
        analyzeButtonText: text('data_sync.entry_mode.compare.action.start', t),
        closeButtonText: text('data_sync.action.close', t),
        badgeText: text('data_sync.entry_mode.data_compare.badge', t),
        resultTitle: text('data_sync.entry_mode.compare.result_title', t),
        readOnly: true,
      };
    default:
      return {
        title: text('data_sync.title.sync_workbench', t),
        description: text('data_sync.title.sync_description', t),
        heroTitle: text('data_sync.title.sync', t),
        heroDescription: text('data_sync.entry_mode.sync.hero_description', t),
        optionTitle: text('data_sync.title.sync_options', t),
        tableSelectLabel: text('data_sync.help.select_tables', t),
        analyzeButtonText: text('data_sync.action.analyze_diff', t),
        closeButtonText: text('data_sync.action.close', t),
        badgeText: text('data_sync.badge.sync_mode', t),
        resultTitle: text('data_sync.step.result', t),
        readOnly: false,
      };
  }
};
