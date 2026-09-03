import Modal from './common/ResizableDraggableModal';
import React, { useEffect, useState, useContext, useMemo, useRef, useCallback } from 'react';
import { Table, Tabs, Button, message, Input, Checkbox, AutoComplete, Tooltip, Select, Empty, Space, Tag, Radio, Spin } from 'antd';
import { ReloadOutlined, SaveOutlined, PlusOutlined, DeleteOutlined, MenuOutlined, FileTextOutlined, EyeOutlined, EditOutlined, ExclamationCircleOutlined, CopyOutlined, TableOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Editor from './MonacoEditor';
import { TabData, ColumnDefinition, IndexDefinition, ForeignKeyDefinition, TriggerDefinition } from '../types';
import { useStore } from '../store';
import { DBGetColumns, DBGetIndexes, DBQuery, DBQueryAudited, DBGetForeignKeys, DBGetTriggers, DBShowCreateTable } from '../../wailsjs/go/app/App';
import { hasIndexFormChanged, normalizeIndexFormFromRow, resolveIndexMetadataResponse, shouldRestoreOriginalIndex, toggleIndexSelection as getNextIndexSelection, type IndexDisplaySnapshot } from './tableDesignerIndexUtils';
import { buildIndexCreateSqlPreview } from './tableDesignerIndexSql';
import { buildAlterTablePreviewSql, buildCreateTablePreviewSql, hasAlterTableDraftChanges, type StarRocksCreateTableOptions, type StarRocksDistributionType, type StarRocksKeyModel, type StarRocksTableKind, type TDengineCreateTableOptions, type TDengineTableKind, type TDengineTagDefinition } from './tableDesignerSchemaSql';
import { summarizeDuckDbPrimaryKeyChange } from './tableDesignerDuckDbPrimaryKey';
import {
    containsTableDesignerTriggerCreateStatement,
    executeTableDesignerSchemaStatements,
    parseTableCommentFromDDL,
    splitSchemaExecutionStatements,
    type TableDesignerSchemaExecutionResult,
} from './tableDesignerExecutionSql';
import TableDesignerSqlPreview from './TableDesignerSqlPreview';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { dispatchSidebarDatabaseRefresh } from '../utils/sidebarDatabaseRefresh';
import { getCurrentLanguage, t } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import {
    getColumnDefinitionExtra,
    normalizeColumnDefinition,
} from '../utils/columnDefinition';
import { buildEditableTriggerSql } from '../utils/triggerEditSql';
import {
    buildTableDesignerTriggerDropSql,
    buildTableDesignerTriggerRestoreSql,
    shouldDropTableDesignerTriggerBeforeReplace,
} from '../utils/tableDesignerTriggerSql';
import { confirmProductionRisk } from '../utils/productionRiskConfirm';
import { findPotentiallyMutatingConnectionStatements } from '../utils/connectionReadOnly';
import {
    isMysqlFamilyDialect as isMysqlFamilySqlDialect,
    isOracleLikeDialect as isOracleLikeSqlDialect,
    isPgLikeDialect as isPgLikeSqlDialect,
    isSqlServerDialect as isSqlServerSqlDialect,
    quoteSqlIdentifierPart,
    quoteSqlIdentifierPath,
    resolveColumnTypeOptions,
    resolveSqlDialect,
} from '../utils/sqlDialect';
import { splitQualifiedNameLast, stripIdentifierQuotes } from '../utils/qualifiedName';
import { loadSchemas } from './sidebar/sidebarMetadataLoaders';
import {
    qualifyTableDesignerCreateName,
    extractTableDesignerCurrentSchema,
    resolveLoadedTableDesignerSchema,
    resolveTableDesignerEditTarget,
    resolveTableDesignerSchema,
    supportsTableDesignerSchemaSelection as supportsRequestedTableDesignerSchemaSelection,
    TABLE_DESIGNER_CURRENT_SCHEMA_SQL,
} from './tableDesignerSchemaContext';
import { buildTDengineStableOptions, buildTDengineStableQueries } from '../utils/tdengineStableMetadata';
import {
    cloneTableDesignerColumnsForPaste,
    parseTableDesignerColumns,
    serializeTableDesignerColumns,
} from './tableDesignerColumnClipboard';

interface EditableColumn extends ColumnDefinition {
    _key: string;
    isNew?: boolean;
    isAutoIncrement?: boolean; // Virtual field for UI
}

interface IndexDisplayRow {
    key: string;
    name: string;
    indexType: string;
    nonUnique: number;
    columnNames: string[];
}

interface ForeignKeyDisplayRow {
    key: string;
    name: string;
    constraintName: string;
    refTableName: string;
    columnNames: string[];
    refColumnNames: string[];
}

type IndexKind = 'NORMAL' | 'UNIQUE' | 'PRIMARY' | 'FULLTEXT' | 'SPATIAL';

interface IndexFormState {
    name: string;
    columnNames: string[];
    kind: IndexKind;
    indexType: string;
}

interface TDengineTagDraft extends TDengineTagDefinition {
    _key: string;
}

interface ForeignKeyFormState {
    constraintName: string;
    columnNames: string[];
    refTableName: string;
    refColumnNames: string[];
}

interface SchemaExecutionResult extends TableDesignerSchemaExecutionResult {
    cancelled?: boolean;
    rawMessage?: string;
}

interface SchemaExecutionOptions {
    skipProductionRiskConfirm?: boolean;
    splitStatements?: boolean;
}

// 通用兜底类型列表
const COMMON_TYPES = [
    { value: 'int' },
    { value: 'varchar(255)' },
    { value: 'text' },
    { value: 'datetime' },
    { value: 'tinyint(1)' },
    { value: 'decimal(10,2)' },
    { value: 'bigint' },
    { value: 'json' },
];

// 按数据库方言分组的完整字段类型列表
const DB_TYPE_OPTIONS: Record<string, { value: string }[]> = {
    mysql: [
        // 数值
        { value: 'tinyint' },
        { value: 'tinyint(1)' },
        { value: 'smallint' },
        { value: 'mediumint' },
        { value: 'int' },
        { value: 'bigint' },
        { value: 'float' },
        { value: 'double' },
        { value: 'decimal(10,2)' },
        // 字符串
        { value: 'char(50)' },
        { value: 'varchar(255)' },
        { value: 'tinytext' },
        { value: 'text' },
        { value: 'mediumtext' },
        { value: 'longtext' },
        // 二进制
        { value: 'binary(255)' },
        { value: 'varbinary(255)' },
        { value: 'tinyblob' },
        { value: 'blob' },
        { value: 'mediumblob' },
        { value: 'longblob' },
        // 日期时间
        { value: 'date' },
        { value: 'time' },
        { value: 'datetime' },
        { value: 'timestamp' },
        { value: 'year' },
        // 其他
        { value: 'json' },
        { value: 'enum' },
        { value: 'set' },
        { value: 'bit(1)' },
    ],
    postgres: [
        // 数值
        { value: 'smallint' },
        { value: 'integer' },
        { value: 'bigint' },
        { value: 'real' },
        { value: 'double precision' },
        { value: 'numeric(10,2)' },
        { value: 'serial' },
        { value: 'bigserial' },
        // 字符串
        { value: 'char(50)' },
        { value: 'varchar(255)' },
        { value: 'text' },
        // 布尔
        { value: 'boolean' },
        // 日期时间
        { value: 'date' },
        { value: 'time' },
        { value: 'timestamp' },
        { value: 'timestamptz' },
        { value: 'interval' },
        // 二进制
        { value: 'bytea' },
        // JSON
        { value: 'json' },
        { value: 'jsonb' },
        // 其他
        { value: 'uuid' },
        { value: 'inet' },
        { value: 'cidr' },
        { value: 'macaddr' },
        { value: 'xml' },
        { value: 'int4range' },
        { value: 'tsquery' },
        { value: 'tsvector' },
    ],
    sqlserver: [
        // 数值
        { value: 'tinyint' },
        { value: 'smallint' },
        { value: 'int' },
        { value: 'bigint' },
        { value: 'float' },
        { value: 'real' },
        { value: 'decimal(10,2)' },
        { value: 'numeric(10,2)' },
        { value: 'money' },
        { value: 'smallmoney' },
        // 字符串
        { value: 'char(50)' },
        { value: 'varchar(255)' },
        { value: 'varchar(max)' },
        { value: 'nchar(50)' },
        { value: 'nvarchar(255)' },
        { value: 'nvarchar(max)' },
        { value: 'text' },
        { value: 'ntext' },
        // 日期时间
        { value: 'date' },
        { value: 'time' },
        { value: 'datetime' },
        { value: 'datetime2' },
        { value: 'datetimeoffset' },
        { value: 'smalldatetime' },
        // 二进制
        { value: 'binary(255)' },
        { value: 'varbinary(255)' },
        { value: 'varbinary(max)' },
        { value: 'image' },
        // 其他
        { value: 'bit' },
        { value: 'uniqueidentifier' },
        { value: 'xml' },
    ],
    sqlite: [
        { value: 'INTEGER' },
        { value: 'REAL' },
        { value: 'TEXT' },
        { value: 'BLOB' },
        { value: 'NUMERIC' },
    ],
    oracle: [
        { value: 'NUMBER(10)' },
        { value: 'NUMBER(10,2)' },
        { value: 'FLOAT' },
        { value: 'BINARY_FLOAT' },
        { value: 'BINARY_DOUBLE' },
        { value: 'CHAR(50)' },
        { value: 'VARCHAR2(255)' },
        { value: 'NVARCHAR2(255)' },
        { value: 'CLOB' },
        { value: 'NCLOB' },
        { value: 'BLOB' },
        { value: 'DATE' },
        { value: 'TIMESTAMP' },
        { value: 'TIMESTAMP WITH TIME ZONE' },
        { value: 'RAW(255)' },
        { value: 'LONG RAW' },
        { value: 'XMLTYPE' },
    ],
};

const COMMON_DEFAULTS = [
    { value: 'CURRENT_TIMESTAMP' },
    { value: 'NULL' },
    { value: '0' },
    { value: "''" },
];

const isMySQLCharacterColumnType = (columnType: string): boolean => (
    /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set|nchar|nvarchar)\b/i.test(String(columnType || '').trim())
);


const PGLIKE_INDEX_TYPE_OPTIONS = [
    { label: 'DEFAULT', value: 'DEFAULT' },
    { label: 'BTREE', value: 'BTREE' },
    { label: 'HASH', value: 'HASH' },
    { label: 'GIN', value: 'GIN' },
    { label: 'GIST', value: 'GIST' },
    { label: 'BRIN', value: 'BRIN' },
    { label: 'SPGIST', value: 'SPGIST' },
];

const SQLSERVER_INDEX_TYPE_OPTIONS = [
    { label: 'DEFAULT', value: 'DEFAULT' },
    { label: 'CLUSTERED', value: 'CLUSTERED' },
    { label: 'NONCLUSTERED', value: 'NONCLUSTERED' },
];

const CHARSETS = [
    { value: 'utf8mb4' },
    { value: 'utf8' },
    { value: 'latin1' },
    { value: 'ascii' },
];

const getCharsetOptions = (i18nLanguage: string) => CHARSETS.map(({ value }) => ({
    label: value === 'utf8mb4'
        ? `${value} ${t('table_designer.option.recommended_suffix', undefined, i18nLanguage)}`
        : value,
    value,
}));

const COLLATIONS = {
    'utf8mb4': [
        { label: 'utf8mb4_unicode_ci', value: 'utf8mb4_unicode_ci' },
        { label: 'utf8mb4_general_ci', value: 'utf8mb4_general_ci' },
        { label: 'utf8mb4_bin', value: 'utf8mb4_bin' },
        { label: 'utf8mb4_0900_ai_ci', value: 'utf8mb4_0900_ai_ci' },
    ],
    'utf8': [
        { label: 'utf8_unicode_ci', value: 'utf8_unicode_ci' },
        { label: 'utf8_general_ci', value: 'utf8_general_ci' },
        { label: 'utf8_bin', value: 'utf8_bin' },
    ],
    'latin1': [
        { label: 'latin1_swedish_ci', value: 'latin1_swedish_ci' },
        { label: 'latin1_general_ci', value: 'latin1_general_ci' },
        { label: 'latin1_bin', value: 'latin1_bin' },
    ],
    'ascii': [
        { label: 'ascii_general_ci', value: 'ascii_general_ci' },
        { label: 'ascii_bin', value: 'ascii_bin' },
    ],
};

const getCollationOptions = (i18nLanguage: string) => Object.fromEntries(
    Object.entries(COLLATIONS).map(([charset, options]) => [
        charset,
        options.map((option, index) => option.value === 'utf8mb4_unicode_ci' && index === 0
            ? { ...option, label: `${option.value} (${t('table_designer.option.default', undefined, i18nLanguage)})` }
            : option),
    ]),
) as typeof COLLATIONS;

const useTableDesignerI18nLanguage = () => {
    const i18n = useOptionalI18n();
    return i18n?.language ?? getCurrentLanguage();
};

// --- Resizable Header Component (Native, same interaction as DataGrid) ---
const ResizableTitle = (props: any) => {
  const { onResizeStart, width, ...restProps } = props;
  const nextStyle = { ...(restProps.style || {}) } as React.CSSProperties;

  if (width) {
    nextStyle.width = width;
  }

  if (!onResizeStart) {
    return <th {...restProps} style={nextStyle} />;
  }

  return (
    <th {...restProps} style={{ ...nextStyle, position: 'relative' }}>
      {restProps.children}
      <span
        className="react-resizable-handle"
        onMouseDown={(e) => {
          e.stopPropagation();
          if (typeof onResizeStart === 'function') {
            onResizeStart(e);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          top: 0,
          width: 10,
          cursor: 'col-resize',
          zIndex: 10,
          touchAction: 'none',
        }}
      />
    </th>
  );
};

// --- Sortable Row Component ---
interface RowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  'data-row-key': string;
}

const SortableRow = ({ children, ...props }: RowProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props['data-row-key'],
  });

  const style: React.CSSProperties = {
    ...props.style,
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: 'move',
    ...(isDragging ? { position: 'relative', zIndex: 9999 } : {}),
  };

  return (
    <tr {...props} ref={setNodeRef} style={style} {...attributes}>
      {React.Children.map(children, child => {
        if ((child as React.ReactElement).key === 'sort') {
          return React.cloneElement(child as React.ReactElement, {
            children: (
                <MenuOutlined
                    style={{ cursor: 'grab', color: '#999' }}
                    {...listeners}
                />
            ),
          });
        }
        return child;
      })}
    </tr>
  );
};

const renderDesignerCellField = (content: React.ReactNode, className?: string) => (
  <div className={`table-designer-cell-field${className ? ` ${className}` : ''}`}>
    {content}
  </div>
);

const renderDesignerCellCheck = (content: React.ReactNode, className?: string) => (
  <div className={`table-designer-cell-check${className ? ` ${className}` : ''}`}>
    {content}
  </div>
);

const renderDesignerHeaderTitle = (title: string) => (
  <span className="table-designer-header-title">{title}</span>
);

const TableDesigner: React.FC<{ tab: TabData; embedded?: boolean }> = ({ tab, embedded = false }) => {
  const isNewTable = !tab.tableName;
  
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [indexes, setIndexes] = useState<IndexDefinition[]>([]);
  const [fks, setFks] = useState<ForeignKeyDefinition[]>([]);
  const [triggers, setTriggers] = useState<TriggerDefinition[]>([]);
  const [ddl, setDdl] = useState<string>('');
  
  // New Table State
  const [newTableName, setNewTableName] = useState('');
  const [schemaOptions, setSchemaOptions] = useState<{ label: string; value: string }[]>([]);
  const [selectedSchema, setSelectedSchema] = useState(() => stripIdentifierQuotes(
      splitQualifiedNameLast(tab.tableName || '').parentPath || tab.schemaName || '',
  ));
  const [schemaSelectionOverride, setSchemaSelectionOverride] = useState(false);
  const [schemaReady, setSchemaReady] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [charset, setCharset] = useState('utf8mb4');
  const [collation, setCollation] = useState('utf8mb4_unicode_ci');
  const [starRocksTableKind, setStarRocksTableKind] = useState<StarRocksTableKind>('olap');
  const [starRocksKeyModel, setStarRocksKeyModel] = useState<StarRocksKeyModel>('DUPLICATE');
  const [starRocksKeyColumns, setStarRocksKeyColumns] = useState<string[]>([]);
  const [starRocksPartitionClause, setStarRocksPartitionClause] = useState('');
  const [starRocksDistributionType, setStarRocksDistributionType] = useState<StarRocksDistributionType>('HASH');
  const [starRocksDistributionColumns, setStarRocksDistributionColumns] = useState<string[]>([]);
  const [starRocksBucketMode, setStarRocksBucketMode] = useState<'AUTO' | 'NUMBER'>('AUTO');
  const [starRocksBucketCount, setStarRocksBucketCount] = useState('');
  const [starRocksProperties, setStarRocksProperties] = useState('');
  const [starRocksRollups, setStarRocksRollups] = useState('');
  const [starRocksExternalEngine, setStarRocksExternalEngine] = useState('hive');
  const [starRocksExternalProperties, setStarRocksExternalProperties] = useState('"resource" = "hive0"\n"database" = "raw_db"\n"table" = "raw_table"');
  const [tdengineTableKind, setTdengineTableKind] = useState<TDengineTableKind>('normal');
  const [tdengineStableName, setTdengineStableName] = useState('');
  const [tdengineTagDefinitions, setTdengineTagDefinitions] = useState<TDengineTagDraft[]>([
      { _key: 'tag-1', name: 'location', type: 'BINARY(64)' },
  ]);
  const [tdengineTagValues, setTdengineTagValues] = useState('');
  const [tdengineStableOptions, setTdengineStableOptions] = useState<{ label: string; value: string }[]>([]);
  const [tdengineStableOptionsLoading, setTdengineStableOptionsLoading] = useState(false);
  const [tdengineChildTagDefs, setTdengineChildTagDefs] = useState<TDengineTagDraft[]>([]);
  const [tdengineChildTagValues, setTdengineChildTagValues] = useState<Record<string, string>>({});
  const [tdengineChildTagDefsLoading, setTdengineChildTagDefsLoading] = useState(false);
  
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [indexesLoading, setIndexesLoading] = useState(false);
  const [foreignKeysLoading, setForeignKeysLoading] = useState(false);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [ddlLoading, setDdlLoading] = useState(false);
  const [previewSql, setPreviewSql] = useState<string>('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [activeKey, setActiveKey] = useState(tab.initialTab || "columns");
  const [selectedColumnRowKeys, setSelectedColumnRowKeys] = useState<string[]>([]);
  const [isCopyColumnsModalOpen, setIsCopyColumnsModalOpen] = useState(false);
  const [copyTableName, setCopyTableName] = useState('');
  const [copyCharset, setCopyCharset] = useState('utf8mb4');
  const [copyCollation, setCopyCollation] = useState('utf8mb4_unicode_ci');
  const [copyExecuting, setCopyExecuting] = useState(false);
  const [tableComment, setTableComment] = useState('');
  const [tableCommentDraft, setTableCommentDraft] = useState('');
  const [isTableCommentModalOpen, setIsTableCommentModalOpen] = useState(false);
  const [tableCommentSaving, setTableCommentSaving] = useState(false);
  const [selectedIndexKeys, setSelectedIndexKeys] = useState<string[]>([]);
  const [isIndexModalOpen, setIsIndexModalOpen] = useState(false);
  const [indexModalMode, setIndexModalMode] = useState<'create' | 'edit'>('create');
  const [indexSaving, setIndexSaving] = useState(false);
  const [indexForm, setIndexForm] = useState<IndexFormState>({
      name: '',
      columnNames: [],
      kind: 'NORMAL',
      indexType: 'DEFAULT',
  });
  const [selectedForeignKey, setSelectedForeignKey] = useState<ForeignKeyDisplayRow | null>(null);
  const [isForeignKeyModalOpen, setIsForeignKeyModalOpen] = useState(false);
  const [foreignKeyModalMode, setForeignKeyModalMode] = useState<'create' | 'edit'>('create');
  const [foreignKeySaving, setForeignKeySaving] = useState(false);
  const [foreignKeyForm, setForeignKeyForm] = useState<ForeignKeyFormState>({
      constraintName: '',
      columnNames: [],
      refTableName: '',
      refColumnNames: [],
  });
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerDefinition | null>(null);
  const [isTriggerModalOpen, setIsTriggerModalOpen] = useState(false);
  const [isTriggerEditModalOpen, setIsTriggerEditModalOpen] = useState(false);
  const [triggerEditMode, setTriggerEditMode] = useState<'create' | 'edit'>('create');
  const [triggerEditSql, setTriggerEditSql] = useState<string>('');
  const [triggerExecuting, setTriggerExecuting] = useState(false);
  const [isCommentModalOpen, setIsCommentModalOpen] = useState(false);
  const [commentEditorColumnKey, setCommentEditorColumnKey] = useState('');
  const [commentEditorColumnName, setCommentEditorColumnName] = useState('');
  const [commentEditorColumnType, setCommentEditorColumnType] = useState('');
  const [commentEditorValue, setCommentEditorValue] = useState('');
  const [columnDefaultEnabled, setColumnDefaultEnabled] = useState(false);
  const [columnDefaultValue, setColumnDefaultValue] = useState('');
  const [columnCharset, setColumnCharset] = useState<string | undefined>();
  const [columnCollation, setColumnCollation] = useState<string | undefined>();
  const [inlineCommentEditingKey, setInlineCommentEditingKey] = useState('');
  
  const connections = useStore(state => state.connections);
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);
  const tableDesignerSchemaByConnection = useStore(state => state.tableDesignerSchemaByConnection || {});
  const setTableDesignerSchema = useStore(state => state.setTableDesignerSchema);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const i18nLanguage = useTableDesignerI18nLanguage();
  const darkMode = theme === 'dark';
  const isV2Ui = appearance.uiVersion === 'v2';
  const resizeGuideColor = darkMode ? '#f6c453' : '#1890ff';
  const readOnly = !!tab.readOnly;
  const designerTableTitle = isNewTable
      ? (newTableName || t('table_designer.title.untitled_table', undefined, i18nLanguage))
      : (splitQualifiedNameLast(tab.tableName || '').objectName || tab.tableName || t('table_designer.title.untitled_table', undefined, i18nLanguage));
  const designerDbTitle = tab.dbName || t('table_designer.title.default_database', undefined, i18nLanguage);
  const designerSchemaTitle = (
      isNewTable ? stripIdentifierQuotes(splitQualifiedNameLast(newTableName).parentPath) : ''
  ) || selectedSchema || tab.schemaName || '';
  const designerColumnSummary = t('table_designer.summary.columns', { count: columns.length }, i18nLanguage);
  const metadataLoading = columnsLoading || indexesLoading || foreignKeysLoading || triggersLoading || ddlLoading;
  const charsetOptions = useMemo(() => getCharsetOptions(i18nLanguage), [i18nLanguage]);
  const collationOptions = useMemo(() => getCollationOptions(i18nLanguage), [i18nLanguage]);
  const panelRadius = 10;
  const panelFrameColor = darkMode ? 'rgba(0, 0, 0, 0.18)' : 'rgba(0, 0, 0, 0.12)';
  const panelToolbarBorder = darkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)';
  const panelToolbarBg = darkMode ? 'rgba(20, 20, 20, 0.35)' : 'rgba(255, 255, 255, 0.72)';
  const panelBodyBg = darkMode ? 'rgba(0, 0, 0, 0.24)' : 'rgba(255, 255, 255, 0.82)';
  const focusRowBg = darkMode ? 'rgba(246, 196, 83, 0.22)' : 'rgba(24, 144, 255, 0.12)';

  const [tableHeight, setTableHeight] = useState(500);
  const containerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const pendingFocusColumnKeyRef = useRef<string | null>(null);
  const focusHighlightTimerRef = useRef<number | null>(null);
  const metadataLoadSeqRef = useRef(0);
  const schemaLoadSeqRef = useRef(0);
  const latestSelectedSchemaRef = useRef(selectedSchema);
  const schemaContextKeyRef = useRef('');
  const [focusColumnKey, setFocusColumnKey] = useState('');

  useEffect(() => {
      latestSelectedSchemaRef.current = selectedSchema;
  }, [selectedSchema]);

  const openCommentEditor = useCallback((record: EditableColumn) => {
      if (!record?._key) return;
      setInlineCommentEditingKey('');
      setCommentEditorColumnKey(record._key);
      setCommentEditorColumnName(record.name || '');
      setCommentEditorColumnType(record.type || '');
      setCommentEditorValue(record.comment || '');
      setColumnDefaultEnabled(record.hasDefault === true);
      setColumnDefaultValue(record.default ?? '');
      setColumnCharset(record.charset);
      setColumnCollation(record.collation);
      setIsCommentModalOpen(true);
  }, []);

  const closeCommentEditor = useCallback(() => {
      setIsCommentModalOpen(false);
      setCommentEditorColumnKey('');
      setCommentEditorColumnName('');
      setCommentEditorColumnType('');
      setCommentEditorValue('');
      setColumnDefaultEnabled(false);
      setColumnDefaultValue('');
      setColumnCharset(undefined);
      setColumnCollation(undefined);
  }, []);

  // 透明 Monaco Editor 主题由 MonacoEditor 包装组件按需注册（含 stickyScroll 不透明背景）

  // 监听字段 Tab 容器高度，为所有 Tab 内表格计算 scroll.y
  // 当 Tab 切换时，字段 Tab 被 display:none 导致 height=0，跳过该次更新保持有效值
  useEffect(() => {
      if (!containerRef.current) return;
      const resizeObserver = new ResizeObserver(entries => {
          for (let entry of entries) {
              const h = entry.contentRect.height;
              // 跳过零高度观测（Tab 面板被隐藏时）
              if (h <= 0) return;
              setTableHeight(Math.max(200, h - 40));
          }
      });
      resizeObserver.observe(containerRef.current);
      return () => resizeObserver.disconnect();
  }, []); // 不依赖 activeKey，仅挂载一次，通过零高度守卫避免 Tab 切换异常

  // --- Resizable Columns State ---
  const [tableColumns, setTableColumns] = useState<any[]>([]);
  const [indexColumns, setIndexColumns] = useState<any[]>([]);
  const resizeDragRef = useRef<{ startX: number; startWidth: number; index: number; containerLeft: number; setter: React.Dispatch<React.SetStateAction<any[]>> } | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const latestResizeXRef = useRef<number | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const resizeBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const resizeListenerRef = useRef<{
    blur: (() => void) | null;
    move: ((e: MouseEvent) => void) | null;
    up: ((e: MouseEvent) => void) | null;
  }>({
    blur: null,
    move: null,
    up: null,
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
      if (tab.initialTab) {
          setActiveKey(tab.initialTab);
      }
  }, [tab.initialTab]);

  useEffect(() => {
      setSelectedColumnRowKeys(prev => prev.filter(key => columns.some(c => c._key === key)));
  }, [columns]);

  useEffect(() => {
      setInlineCommentEditingKey(prev => (prev && columns.some(c => c._key === prev) ? prev : ''));
  }, [columns]);

  useEffect(() => {
      return () => {
          if (focusHighlightTimerRef.current !== null) {
              window.clearTimeout(focusHighlightTimerRef.current);
          }
      };
  }, []);

  const focusColumnRow = useCallback((targetKey: string): boolean => {
      // TDengine's new-table view embeds the columns table in its tdengine tab.
      if (activeKey !== 'columns' && activeKey !== 'tdengine') return false;
      const tableBody = containerRef.current?.querySelector('.ant-table-body') as HTMLElement | null;
      if (!tableBody) return false;
      const row = tableBody.querySelector(`tr[data-row-key="${targetKey}"]`) as HTMLTableRowElement | null;
      if (!row) return false;

      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setFocusColumnKey(targetKey);
      if (focusHighlightTimerRef.current !== null) {
          window.clearTimeout(focusHighlightTimerRef.current);
      }
      focusHighlightTimerRef.current = window.setTimeout(() => {
          setFocusColumnKey(prev => (prev === targetKey ? '' : prev));
      }, 1600);

      if (!readOnly) {
          const firstInput = row.querySelector('input') as HTMLInputElement | null;
          if (firstInput) {
              firstInput.focus();
              firstInput.select();
          }
      }
      return true;
  }, [activeKey, readOnly]);

  const startInlineCommentEdit = useCallback((record: EditableColumn) => {
      if (readOnly || !record?._key) return;
      setInlineCommentEditingKey(record._key);
  }, [readOnly]);

  const finishInlineCommentEdit = useCallback(() => {
      setInlineCommentEditingKey('');
  }, []);

  useEffect(() => {
      const pendingKey = pendingFocusColumnKeyRef.current;
      // TDengine's new-table view embeds the columns table in its tdengine tab.
      if (!pendingKey || (activeKey !== 'columns' && activeKey !== 'tdengine')) return;

      let cancelled = false;
      const tryFocus = () => {
          if (cancelled) return;
          if (focusColumnRow(pendingKey)) {
              pendingFocusColumnKeyRef.current = null;
          }
      };

      const timerA = window.setTimeout(tryFocus, 0);
      const timerB = window.setTimeout(tryFocus, 96);
      return () => {
          cancelled = true;
          window.clearTimeout(timerA);
          window.clearTimeout(timerB);
      };
  }, [activeKey, columns, focusColumnRow]);

  // Initial Columns Definition
  useEffect(() => {
      const columnTypeOptions = resolveColumnTypeOptions(getDbType());
      const initialCols = [
          { 
              title: renderDesignerHeaderTitle(t('table_designer.column.name', undefined, i18nLanguage)),
              dataIndex: 'name', 
              key: 'name', 
              width: 180,
              render: (text: string, record: EditableColumn) => readOnly ? text : (
                  renderDesignerCellField(
                      <Input {...noAutoCapInputProps} value={text} onChange={e => handleColumnChange(record._key, 'name', e.target.value)} variant="borderless" />
                  )
              )
          },
          { 
              title: renderDesignerHeaderTitle(t('table_designer.column.type', undefined, i18nLanguage)),
              dataIndex: 'type', 
              key: 'type', 
              width: 150,
              render: (text: string, record: EditableColumn) => readOnly ? text : (
                  renderDesignerCellField(
                      <AutoComplete options={columnTypeOptions} value={text} onChange={val => handleColumnChange(record._key, 'type', val)} style={{ width: '100%' }} variant="borderless" />,
                      'is-compact'
                  )
              )
          },
          { 
              title: renderDesignerHeaderTitle(t('table_designer.column.primary_key', undefined, i18nLanguage)),
              dataIndex: 'key', 
              key: 'key', 
              width: 60,
              align: 'center',
              render: (text: string, record: EditableColumn) => (
                  renderDesignerCellCheck(
                      <Checkbox checked={text === 'PRI'} disabled={readOnly || isTDengineNewTable} onChange={e => handleColumnChange(record._key, 'key', e.target.checked ? 'PRI' : '')} />,
                      'is-left-aligned'
                  )
              )
          },
          {
              title: renderDesignerHeaderTitle(t('table_designer.column.auto_increment', undefined, i18nLanguage)),
              dataIndex: 'isAutoIncrement',
              key: 'isAutoIncrement',
              width: 60,
              align: 'center',
              render: (val: boolean, record: EditableColumn) => (
                  renderDesignerCellCheck(
                      <Checkbox checked={val} disabled={readOnly || isTDengineNewTable} onChange={e => handleColumnChange(record._key, 'isAutoIncrement', e.target.checked)} />,
                      'is-left-aligned'
                  )
              )
          },
          { 
              title: renderDesignerHeaderTitle(t('table_designer.column.not_null', undefined, i18nLanguage)),
              dataIndex: 'nullable', 
              key: 'nullable', 
              width: 80,
              align: 'center',
              render: (text: string, record: EditableColumn) => (
                  renderDesignerCellCheck(
                      <Checkbox checked={text === 'NO'} disabled={readOnly || record.key === 'PRI'} onChange={e => handleColumnChange(record._key, 'nullable', e.target.checked ? 'NO' : 'YES')} />,
                      'is-left-aligned'
                  )
              )
          },
          { 
              title: renderDesignerHeaderTitle(t('table_designer.column.default', undefined, i18nLanguage)),
              dataIndex: 'default', 
              key: 'default', 
              width: 180, // Increased default width
              render: (text: string | undefined, record: EditableColumn) => {
                  const value = record.hasDefault
                      ? (text === '' ? "''" : (text ?? ''))
                      : undefined;
                  if (readOnly) return value;
                  return renderDesignerCellField(
                      <AutoComplete
                          options={COMMON_DEFAULTS}
                          value={value}
                          onChange={val => {
                              const hasDefault = val.length > 0;
                              handleColumnChange(record._key, 'default', hasDefault ? (val === "''" ? '' : val) : undefined);
                              handleColumnChange(record._key, 'hasDefault', hasDefault);
                          }}
                          style={{ width: '100%' }}
                          variant="borderless"
                      />
                  );
              }
          },
          { 
              title: renderDesignerHeaderTitle(t('table_designer.column.comment', undefined, i18nLanguage)),
              dataIndex: 'comment', 
              key: 'comment',
              width: 200,
              render: (text: string, record: EditableColumn) => readOnly ? (
                  <Tooltip title={text || ''}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text || ''}</div>
                  </Tooltip>
              ) : (
                  <div className="table-designer-cell-field table-designer-comment-field">
                      {inlineCommentEditingKey !== record._key ? (
                          <Tooltip title={text || ''}>
                              <div
                                  className={`table-designer-comment-display${text ? '' : ' is-empty'}`}
                                  onDoubleClick={() => startInlineCommentEdit(record)}
                              >
                                  {text || '\u00A0'}
                              </div>
                          </Tooltip>
                      ) : (
                          <Input
                              value={text}
                              onChange={e => handleColumnChange(record._key, 'comment', e.target.value)}
                              onBlur={finishInlineCommentEdit}
                              onPressEnter={finishInlineCommentEdit}
                              autoFocus={inlineCommentEditingKey === record._key}
                              variant="borderless"
                          />
                      )}
                      <Tooltip title={t('table_designer.tooltip.edit_column_options', undefined, i18nLanguage)}>
                          <Button
                              type="text"
                              size="small"
                              icon={<EditOutlined />}
                              onClick={() => openCommentEditor(record)}
                          />
                      </Tooltip>
                  </div>
              )
          },
          ...(readOnly ? [] : [{
              title: renderDesignerHeaderTitle(t('table_designer.column.actions', undefined, i18nLanguage)),
              key: 'action',
              width: 92,
              className: 'table-designer-action-column',
              onHeaderCell: () => ({ className: 'table-designer-action-column' }),
              render: (_: any, record: EditableColumn) => (
                  <div className="table-designer-action-cell">
                      <Tooltip title={t('table_designer.tooltip.edit_column_options', undefined, i18nLanguage)}>
                          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openCommentEditor(record)} />
                      </Tooltip>
                      <Tooltip title={t('table_designer.action.delete', undefined, i18nLanguage)}>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteColumn(record._key)} />
                      </Tooltip>
                  </div>
              )
          }])
      ];
      setTableColumns(initialCols);
  }, [connections, finishInlineCommentEdit, i18nLanguage, inlineCommentEditingKey, openCommentEditor, readOnly, startInlineCommentEdit, tab.connectionId]); // Re-create when datasource dialect, language, inline comment state, or readonly state changes

  const flushResizeGhost = useCallback(() => {
    resizeRafRef.current = null;
    if (!resizeDragRef.current || !ghostRef.current) return;
    if (latestResizeXRef.current === null) return;
    const relativeLeft = latestResizeXRef.current - resizeDragRef.current.containerLeft;
    ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
  }, []);

  const detachResizeListeners = useCallback(() => {
    if (resizeListenerRef.current.move) {
      document.removeEventListener('mousemove', resizeListenerRef.current.move);
      resizeListenerRef.current.move = null;
    }
    if (resizeListenerRef.current.up) {
      document.removeEventListener('mouseup', resizeListenerRef.current.up);
      resizeListenerRef.current.up = null;
    }
    if (resizeListenerRef.current.blur) {
      window.removeEventListener('blur', resizeListenerRef.current.blur);
      resizeListenerRef.current.blur = null;
    }
  }, []);

  const cleanupResizeState = useCallback(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    latestResizeXRef.current = null;
    resizeDragRef.current = null;
    if (ghostRef.current) {
      ghostRef.current.style.display = 'none';
    }
    const previousBodyStyle = resizeBodyStyleRef.current;
    resizeBodyStyleRef.current = null;
    if (previousBodyStyle) {
      document.body.style.cursor = previousBodyStyle.cursor;
      document.body.style.userSelect = previousBodyStyle.userSelect;
    }
  }, []);

  const finishResize = useCallback((clientX?: number, commit = true) => {
    const dragState = resizeDragRef.current;
    const latestResizeX = latestResizeXRef.current;
    detachResizeListeners();
    cleanupResizeState();

    if (commit && dragState) {
      const finalClientX = Number.isFinite(clientX) ? clientX as number : latestResizeX ?? dragState.startX;
      const newWidth = Math.max(50, dragState.startWidth + finalClientX - dragState.startX);
      dragState.setter((prevColumns) => {
        if (!prevColumns[dragState.index]) return prevColumns;
        const nextColumns = [...prevColumns];
        nextColumns[dragState.index] = {
          ...nextColumns[dragState.index],
          width: newWidth,
        };
        return nextColumns;
      });
    }
  }, [cleanupResizeState, detachResizeListeners]);

  const createResizeStartHandler = useCallback((columns: any[], setter: React.Dispatch<React.SetStateAction<any[]>>) => (index: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    finishResize(undefined, false);

    const startX = e.clientX;
    const currentWidth = Number(columns[index]?.width || 200);
    const containerLeft = shellRef.current?.getBoundingClientRect().left ?? 0;
    resizeDragRef.current = { startX, startWidth: currentWidth, index, containerLeft, setter };
    latestResizeXRef.current = startX;

    if (ghostRef.current && shellRef.current) {
      const relativeLeft = startX - containerLeft;
      ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
      ghostRef.current.style.display = 'block';
    }

    const onMove = (event: MouseEvent) => {
      if (!resizeDragRef.current) return;
      latestResizeXRef.current = event.clientX;
      if (event.buttons === 0) {
        finishResize(event.clientX);
        return;
      }
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(flushResizeGhost);
    };
    const onUp = (event: MouseEvent) => finishResize(event.clientX);
    const onBlur = () => finishResize();

    resizeListenerRef.current = { blur: onBlur, move: onMove, up: onUp };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    resizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [finishResize, flushResizeGhost]);

  const handleResizeStart = useMemo(() => createResizeStartHandler(tableColumns, setTableColumns), [createResizeStartHandler, tableColumns]);
  const handleIndexResizeStart = useMemo(() => createResizeStartHandler(indexColumns, setIndexColumns), [createResizeStartHandler, indexColumns]);

  useEffect(() => {
    return () => {
      finishResize(undefined, false);
    };
  }, [finishResize]);

  const clearMetadataLoading = () => {
    setColumnsLoading(false);
    setIndexesLoading(false);
    setForeignKeysLoading(false);
    setTriggersLoading(false);
    setDdlLoading(false);
  };

  const formatLoadError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    return String(error || '');
  };

  const fetchData = async () => {
    const requestSeq = metadataLoadSeqRef.current + 1;
    metadataLoadSeqRef.current = requestSeq;
    const isCurrentRequest = () => metadataLoadSeqRef.current === requestSeq;

    if (isNewTable) {
        clearMetadataLoading();
        return;
    }

    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
        message.error(t('table_designer.message.connection_not_found', undefined, i18nLanguage));
        clearMetadataLoading();
        return;
    }

    const config = { 
        ...conn.config, 
        port: Number(conn.config.port),
        password: conn.config.password || "",
        database: conn.config.database || "",
        useSSH: conn.config.useSSH || false,
        ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
    };

    const rpcConfig = buildRpcConnectionConfig(config) as any;
      const dbName = tab.dbName || '';
      const tableInfo = resolveTableInfo();
      const resolvedTableName = supportsRequestedTableDesignerSchemaSelection(tableInfo.dbType)
          ? tableInfo.qualifiedName
          : (tab.tableName || '');
      const tableName = resolvedTableName || tab.tableName || '';

      setColumnsLoading(true);
    setIndexesLoading(true);
    setForeignKeysLoading(true);
    setTriggersLoading(true);
    setDdlLoading(true);

    const loadColumns = DBGetColumns(rpcConfig, dbName, tableName)
        .then((colsRes) => {
            if (!isCurrentRequest()) return;
            if (colsRes.success) {
                const colsWithKey = (colsRes.data as ColumnDefinition[]).map((c, index) => ({
                    ...normalizeColumnDefinition(c),
                    _key: `col-${index}-${Date.now()}`,
                    isAutoIncrement: getColumnDefinitionExtra(c).toLowerCase().includes('auto_increment')
                }));
                setColumns(JSON.parse(JSON.stringify(colsWithKey)));
                setOriginalColumns(JSON.parse(JSON.stringify(colsWithKey)));
                setSelectedColumnRowKeys([]);
            } else {
                message.error(t('table_designer.message.load_columns_failed', { detail: colsRes.message }, i18nLanguage));
            }
        })
        .catch((error: unknown) => {
            if (!isCurrentRequest()) return;
            message.error(t('table_designer.message.load_columns_failed', { detail: formatLoadError(error) }, i18nLanguage));
        })
        .finally(() => {
            if (isCurrentRequest()) setColumnsLoading(false);
        });

    await loadColumns;
    if (!isCurrentRequest()) return;

    const loadIndexes = DBGetIndexes(rpcConfig, dbName, tableName)
        .then((idxRes) => {
            if (!isCurrentRequest()) return;
            const result = resolveIndexMetadataResponse<IndexDefinition>(idxRes);
            setIndexes(result.indexes);
            if (result.errorDetail !== null) {
                message.error(t('table_designer.message.load_indexes_failed', {
                    detail: result.errorDetail || t('table_designer.fallback.unknown_error', undefined, i18nLanguage),
                }, i18nLanguage));
            }
        })
        .catch((error: unknown) => {
            if (!isCurrentRequest()) return;
            setIndexes([]);
            message.error(t('table_designer.message.load_indexes_failed', {
                detail: formatLoadError(error) || t('table_designer.fallback.unknown_error', undefined, i18nLanguage),
            }, i18nLanguage));
        })
        .finally(() => {
            if (isCurrentRequest()) setIndexesLoading(false);
        });

    const loadForeignKeys = DBGetForeignKeys(rpcConfig, dbName, tableName)
        .then((fkRes) => {
            if (!isCurrentRequest()) return;
            setFks(fkRes.success && Array.isArray(fkRes.data) ? fkRes.data : []);
        })
        .catch(() => {
            if (isCurrentRequest()) setFks([]);
        })
        .finally(() => {
            if (isCurrentRequest()) setForeignKeysLoading(false);
        });

    const loadTriggers = DBGetTriggers(rpcConfig, dbName, tableName)
        .then((trigRes) => {
            if (!isCurrentRequest()) return;
            setTriggers(trigRes.success && Array.isArray(trigRes.data) ? trigRes.data : []);
        })
        .catch(() => {
            if (isCurrentRequest()) setTriggers([]);
        })
        .finally(() => {
            if (isCurrentRequest()) setTriggersLoading(false);
        });

    const loadDdl = DBShowCreateTable(rpcConfig, dbName, tableName)
        .then((ddlRes) => {
            if (!isCurrentRequest() || !ddlRes.success) return;
            const ddlText = String(ddlRes.data || '');
            setDdl(ddlText);
            const parsedTableComment = parseTableCommentFromDDL(ddlText);
            setTableComment(parsedTableComment);
            if (!isTableCommentModalOpen) {
                setTableCommentDraft(parsedTableComment);
            }
        })
        .catch(() => undefined)
        .finally(() => {
            if (isCurrentRequest()) setDdlLoading(false);
        });

    await Promise.allSettled([loadIndexes, loadForeignKeys, loadTriggers, loadDdl]);
  };

  useEffect(() => {
    fetchData();
  }, [tab, selectedSchema]);

  // --- Trigger Handlers ---

  const normalizeDbType = (rawType: string): string => {
      const normalized = String(rawType || '').trim().toLowerCase();
      if (normalized === 'postgresql' || normalized === 'pg') return 'postgres';
      if (normalized === 'mssql' || normalized === 'sql_server' || normalized === 'sql-server') return 'sqlserver';
      if (normalized === 'doris') return 'diros';
      if (normalized === 'open_gauss' || normalized === 'open-gauss') return 'opengauss';
      if (normalized === 'gauss_db' || normalized === 'gauss-db') return 'gaussdb';
      return normalized;
  };

  const inferDialectFromCustomDriver = (driver: string): string => {
      const customDriver = normalizeDbType(driver);
      if (!customDriver) return 'custom';
      if (
          customDriver === 'mariadb'
          || customDriver === 'diros'
          || customDriver === 'sphinx'
          || customDriver === 'tidb'
          || customDriver === 'oceanbase'
          || customDriver.includes('mysql')
      ) {
          return 'mysql';
      }
      if (customDriver === 'starrocks') return 'starrocks';
      if (customDriver === 'dameng') return 'dm';
      return customDriver;
  };

  const getDbType = (): string => {
    const conn = connections.find(c => c.id === tab.connectionId);
    const rawType = String(conn?.config?.type || '').trim();
    if (!rawType) return '';
    return resolveSqlDialect(rawType, String(conn?.config?.driver || ''), {
      oceanBaseProtocol: conn?.config?.oceanBaseProtocol,
    });
  };

  const supportsTableDesignerSchemaSelection = supportsRequestedTableDesignerSchemaSelection(getDbType());

  useEffect(() => {
      if (!supportsTableDesignerSchemaSelection) {
          schemaLoadSeqRef.current += 1;
          schemaContextKeyRef.current = '';
          latestSelectedSchemaRef.current = '';
          setSchemaOptions([]);
          setSelectedSchema('');
          setSchemaSelectionOverride(false);
          setSchemaReady(true);
          setSchemaLoading(false);
          return;
      }

      const conn = connections.find(c => c.id === tab.connectionId);
      const dbName = String(tab.dbName || '').trim();
      if (!conn || !dbName) {
          setSchemaReady(false);
          return;
      }

      const requestSeq = schemaLoadSeqRef.current + 1;
      schemaLoadSeqRef.current = requestSeq;
      const explicitSchema = stripIdentifierQuotes(
          splitQualifiedNameLast(tab.tableName || '').parentPath || tab.schemaName || '',
      );
      const rememberedSchema = tableDesignerSchemaByConnection[tab.connectionId] || '';
      const contextKey = [tab.connectionId, dbName, tab.tableName || 'new'].join('::');
      if (schemaContextKeyRef.current !== contextKey) {
          schemaContextKeyRef.current = contextKey;
          latestSelectedSchemaRef.current = explicitSchema;
          setSelectedSchema(explicitSchema);
          setSchemaSelectionOverride(false);
          setSchemaOptions(explicitSchema ? [{ label: explicitSchema, value: explicitSchema }] : []);
      }

      let cancelled = false;
      setSchemaReady(false);
      setSchemaLoading(true);
      const loadCurrentSchema = DBQuery(
          buildRpcConnectionConfig({
              ...conn.config,
              port: Number(conn.config.port),
              password: conn.config.password || '',
              database: conn.config.database || '',
              useSSH: conn.config.useSSH || false,
              ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
          }) as any,
          dbName,
          TABLE_DESIGNER_CURRENT_SCHEMA_SQL,
      ).then(result => {
          if (!result.success) return '';
          return extractTableDesignerCurrentSchema(result.data);
      }).catch(() => '');

      void Promise.all([loadSchemas(conn, dbName), loadCurrentSchema])
          .then(([result, currentSchema]) => {
              if (cancelled) return;
              const schemaNames = Array.from(new Map(
                  (Array.isArray(result.schemas) ? result.schemas : [])
                      .map(schema => String(schema || '').trim())
                      .filter(Boolean)
                      .map(schema => [schema.toLocaleLowerCase(), schema] as const),
              ).values());
              const resolved = resolveLoadedTableDesignerSchema({
                  requestSeq,
                  currentRequestSeq: schemaLoadSeqRef.current,
                  latestSelectedSchema: latestSelectedSchemaRef.current,
                  explicitSchema,
                  rememberedSchema,
                  currentSchema,
                  schemaNames,
              });
              if (!resolved) return;
              latestSelectedSchemaRef.current = resolved.selectedSchema;
              setSelectedSchema(resolved.selectedSchema);
              setSchemaOptions(resolved.schemaNames.map(schema => ({ label: schema, value: schema })));
              if (resolved.selectedSchema) {
                  setTableDesignerSchema?.(tab.connectionId, resolved.selectedSchema);
              }
          })
          .catch(() => {
              if (cancelled || requestSeq !== schemaLoadSeqRef.current) return;
              const fallback = latestSelectedSchemaRef.current || explicitSchema;
              setSelectedSchema(fallback);
              setSchemaOptions(fallback ? [{ label: fallback, value: fallback }] : []);
          })
          .finally(() => {
              if (!cancelled && requestSeq === schemaLoadSeqRef.current) {
                  setSchemaReady(true);
                  setSchemaLoading(false);
              }
          });

      return () => {
          cancelled = true;
      };
  }, [connections, supportsTableDesignerSchemaSelection, tab.connectionId, tab.dbName, tab.schemaName, tab.tableName]);

  const handleSchemaChange = (schemaName: string) => {
      const nextSchema = String(schemaName || '').trim();
      if (!nextSchema || nextSchema === selectedSchema) return;
      const applySchema = () => {
          if (!isNewTable) {
              setColumns([]);
              setOriginalColumns([]);
              setIndexes([]);
              setFks([]);
              setTriggers([]);
              setDdl('');
              setSelectedColumnRowKeys([]);
          }
          latestSelectedSchemaRef.current = nextSchema;
          setSelectedSchema(nextSchema);
          setSchemaSelectionOverride(!isNewTable);
          setTableDesignerSchema?.(tab.connectionId, nextSchema);
      };
      if (hasUnsavedDraftChanges) {
          Modal.confirm({
              title: t('table_designer.modal.unsaved_changes_title', undefined, i18nLanguage),
              icon: <ExclamationCircleOutlined />,
              content: t('table_designer.modal.unsaved_changes_content', undefined, i18nLanguage),
              okText: t('table_designer.action.refresh_anyway', undefined, i18nLanguage),
              cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
              onOk: applySchema,
          });
          return;
      }
      applySchema();
  };

  const generateTriggerTemplate = (): string => {
    const dbType = getDbType();
    const tableInfo = resolveTableInfo();
    const tblName = tableInfo.tableRef || (
        supportsRequestedTableDesignerSchemaSelection(dbType)
          ? tableInfo.qualifiedName
          : (tab.tableName || 'table_name')
    );

    switch (dbType) {
      case 'mysql':
      case 'mariadb':
      case 'oceanbase':
      case 'diros':
      case 'starrocks':
        {
          const tableRef = quoteIdentifierPathByDialect(tblName, dbType);
          return `CREATE TRIGGER trigger_name
BEFORE INSERT ON ${tableRef}
FOR EACH ROW
BEGIN
    -- Trigger logic
END;`;
        }
      case 'postgres':
      case 'kingbase':
      case 'highgo':
      case 'vastbase':
      case 'opengauss':
      case 'gaussdb': {
        const tableRef = quoteIdentifierPathByDialect(tblName, dbType);
        return `CREATE OR REPLACE FUNCTION trigger_function_name()
RETURNS TRIGGER AS $$
BEGIN
    -- Trigger logic
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_name
BEFORE INSERT ON ${tableRef}
FOR EACH ROW
EXECUTE FUNCTION trigger_function_name();`;
      }
      case 'sqlserver':
        {
          const tableRef = quoteIdentifierPathByDialect(tblName, dbType);
          return `CREATE TRIGGER trigger_name
ON ${tableRef}
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    -- Trigger logic
END;`;
        }
      case 'oracle':
      case 'dameng':
      case 'dm':
        {
          const tableRef = quoteIdentifierPathByDialect(tblName, dbType);
          return `CREATE OR REPLACE TRIGGER trigger_name
BEFORE INSERT ON ${tableRef}
FOR EACH ROW
BEGIN
    -- Trigger logic
    NULL;
END;`;
        }
      case 'sqlite':
        {
          const tableRef = quoteIdentifierPathByDialect(tblName, dbType);
          return `CREATE TRIGGER trigger_name
AFTER INSERT ON ${tableRef}
BEGIN
    -- Trigger logic
END;`;
        }
      default:
        return `-- Enter a CREATE TRIGGER statement`;
    }
  };

  const buildDropTriggerSql = (triggerName: string): string => {
    const dbType = getDbType();
    const tableInfo = resolveTableInfo();
    const tblName = tableInfo.tableRef || (
        supportsRequestedTableDesignerSchemaSelection(dbType)
          ? tableInfo.qualifiedName
          : (tab.tableName || '')
    );

    return buildTableDesignerTriggerDropSql(triggerName, tblName, dbType, tableInfo.schema);
  };

  const handleCreateTrigger = () => {
    setTriggerEditMode('create');
    setTriggerEditSql(generateTriggerTemplate());
    setIsTriggerEditModalOpen(true);
  };

  const handleEditTrigger = () => {
    if (!selectedTrigger) return;
    const dbType = getDbType();
    const tableInfo = resolveTableInfo();
    const tblName = tableInfo.tableRef || (
        supportsRequestedTableDesignerSchemaSelection(dbType)
          ? tableInfo.qualifiedName
          : (tab.tableName || '')
    );
    let createSql = '';

    const triggerRollbackSql = buildTableDesignerTriggerRestoreSql(selectedTrigger, tblName, dbType, tableInfo.schema);
    createSql = triggerRollbackSql
      || selectedTrigger.statement
      || '-- Trigger definition unavailable';
    const triggerDropSql = shouldDropTableDesignerTriggerBeforeReplace(triggerRollbackSql, dbType)
      ? buildDropTriggerSql(selectedTrigger.name)
      : '';

    const dbName = String(tab.dbName || '').trim();
    const schemaName = String(selectedSchema || tab.schemaName || '').trim();
    setActiveContext({
      connectionId: tab.connectionId,
      dbName,
      schemaName: schemaName || undefined,
    });
    addTab({
      id: `query-edit-trigger-${tab.connectionId}-${dbName}-${tab.tableName || ''}-${selectedTrigger.name}-${Date.now()}`,
      title: t('table_designer.tab.edit_trigger_title', { name: selectedTrigger.name }, i18nLanguage),
      type: 'query',
      connectionId: tab.connectionId,
      dbName,
      schemaName: schemaName || undefined,
      query: buildEditableTriggerSql(selectedTrigger.name, createSql, {
        dropSql: triggerDropSql,
        dbType,
      }),
      triggerName: selectedTrigger.name,
      triggerTableName: tblName,
      triggerRollbackSql: triggerRollbackSql || undefined,
      queryMode: 'object-edit',
    });
  };

  const handleDeleteTrigger = () => {
    if (!selectedTrigger) return;

    Modal.confirm({
      title: t('table_designer.modal.delete_trigger_title', undefined, i18nLanguage),
      icon: <ExclamationCircleOutlined />,
      content: t('table_designer.modal.delete_trigger_content', { name: selectedTrigger.name }, i18nLanguage),
      okText: t('table_designer.action.delete', undefined, i18nLanguage),
      okType: 'danger',
      cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
      onOk: async () => {
        const conn = connections.find(c => c.id === tab.connectionId);
        if (!conn) {
          message.error(t('table_designer.message.connection_not_found', undefined, i18nLanguage));
          return;
        }

        const approved = await confirmProductionRisk({
          connection: conn,
          action: t('connection.production_risk.action.execute_sql'),
          target: [tab.dbName, selectedTrigger.name].filter(Boolean).join(' / '),
          translate: (key, params) => t(key, params, i18nLanguage),
        });
        if (!approved) return;

        const dropSql = buildDropTriggerSql(selectedTrigger.name);

        try {
          const result = await executeSchemaStatements(dropSql, {
            skipProductionRiskConfirm: true,
          });
          if (result.ok) {
            setSelectedTrigger(null);
            await fetchData();
            message.success(t('table_designer.message.trigger_deleted', undefined, i18nLanguage));
          } else {
            if (result.schemaMayHaveChanged) await fetchData();
            message.error(t('table_designer.message.delete_failed', {
              detail: result.rawMessage || result.message,
            }, i18nLanguage));
          }
        } catch (e: any) {
          message.error(t('table_designer.message.delete_failed', { detail: e?.message || String(e) }, i18nLanguage));
        }
      }
    });
  };

  const handleExecuteTriggerSql = async () => {
    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
      message.error(t('table_designer.message.connection_not_found', undefined, i18nLanguage));
      return;
    }

    const dbType = getDbType();
    if (
      !String(triggerEditSql || '').trim()
      || splitSchemaExecutionStatements(triggerEditSql, dbType).length === 0
    ) {
      message.error(t('table_designer.message.no_sql_statement', undefined, i18nLanguage));
      return;
    }
    if (!containsTableDesignerTriggerCreateStatement(triggerEditSql, dbType)) {
      message.error(t('trigger_viewer.edit_sql.empty_definition', undefined, i18nLanguage));
      return;
    }

    const approved = await confirmProductionRisk({
      connection: conn,
      action: t('connection.production_risk.action.execute_sql'),
      target: [tab.dbName, selectedTrigger?.name].filter(Boolean).join(' / '),
      translate: (key, params) => t(key, params, i18nLanguage),
    });
    if (!approved) return;

    setTriggerExecuting(true);

    try {
      let triggerSchemaMayHaveChanged = false;
      const tableInfo = resolveTableInfo();
      const restoreTableName = tableInfo.tableRef || (
        supportsRequestedTableDesignerSchemaSelection(dbType)
          ? tableInfo.qualifiedName
          : (tab.tableName || '')
      );
      const restoreSql = triggerEditMode === 'edit' && selectedTrigger
        ? buildTableDesignerTriggerRestoreSql(selectedTrigger, restoreTableName, dbType, tableInfo.schema)
        : '';
      const shouldDropExistingTrigger = triggerEditMode === 'edit'
        && Boolean(selectedTrigger)
        && shouldDropTableDesignerTriggerBeforeReplace(restoreSql, dbType);
      // 如果是编辑模式，先删除旧触发器
      if (shouldDropExistingTrigger && selectedTrigger) {
        const dropSql = buildDropTriggerSql(selectedTrigger.name);
        const dropResult = await executeSchemaStatements(dropSql, {
          skipProductionRiskConfirm: true,
        });
        if (!dropResult.ok) {
          const failureDetail = dropResult.rawMessage || dropResult.message;
          if (dropResult.outcomeUnknown) {
            await fetchData();
            message.error(t('table_designer.message.trigger_outcome_unknown', {
              detail: failureDetail,
            }, i18nLanguage));
          } else if (dropResult.schemaMayHaveChanged && restoreSql) {
            const restoreResult = await executeSchemaStatements(restoreSql, {
              skipProductionRiskConfirm: true,
              splitStatements: false,
            });
            await fetchData();
            message.error(restoreResult.ok
              ? t('table_designer.message.trigger_restored_after_failure', {
                detail: failureDetail,
              }, i18nLanguage)
              : t('table_designer.message.trigger_restore_failed', {
                detail: failureDetail,
                restoreDetail: restoreResult.rawMessage || restoreResult.message,
              }, i18nLanguage));
          } else {
            if (dropResult.schemaMayHaveChanged) await fetchData();
            message.error(t('table_designer.message.drop_old_trigger_failed', {
              detail: failureDetail,
            }, i18nLanguage));
          }
          return;
        }
        triggerSchemaMayHaveChanged = true;
      }

      // 执行创建语句
      const result = await executeSchemaStatements(triggerEditSql, {
        skipProductionRiskConfirm: true,
        splitStatements: false,
      });
      if (result.ok) {
        setIsTriggerEditModalOpen(false);
        setSelectedTrigger(null);
        await fetchData();
        message.success(triggerEditMode === 'create'
            ? t('table_designer.message.trigger_created', undefined, i18nLanguage)
            : t('table_designer.message.trigger_updated', undefined, i18nLanguage));
      } else {
        if (triggerSchemaMayHaveChanged || result.schemaMayHaveChanged) await fetchData();
        const failureDetail = result.rawMessage || result.message;
        if (result.outcomeUnknown) {
          message.error(t('table_designer.message.trigger_outcome_unknown', {
            detail: failureDetail,
          }, i18nLanguage));
        } else if (triggerSchemaMayHaveChanged && restoreSql) {
          const restoreResult = await executeSchemaStatements(restoreSql, {
            skipProductionRiskConfirm: true,
            splitStatements: false,
          });
          if (restoreResult.ok) {
            await fetchData();
            message.error(t('table_designer.message.trigger_restored_after_failure', {
              detail: failureDetail,
            }, i18nLanguage));
          } else {
            await fetchData();
            message.error(t('table_designer.message.trigger_restore_failed', {
              detail: failureDetail,
              restoreDetail: restoreResult.rawMessage || restoreResult.message,
            }, i18nLanguage));
          }
        } else if (triggerSchemaMayHaveChanged) {
          message.error(t('table_designer.message.trigger_restore_unavailable', {
            detail: failureDetail,
          }, i18nLanguage));
        } else {
          message.error(t('table_designer.message.execution_failed', {
            detail: failureDetail,
          }, i18nLanguage));
        }
      }
    } catch (e: any) {
      message.error(t('table_designer.message.execution_failed', { detail: e?.message || String(e) }, i18nLanguage));
    } finally {
      setTriggerExecuting(false);
    }
  };

  // --- Handlers ---

  const handleColumnChange = (key: string, field: keyof EditableColumn, value: any) => {
      setColumns(prev => prev.map(col => {
          if (col._key === key) {
              const newCol = { ...col, [field]: value };
              if (field === 'key' && value === 'PRI') newCol.nullable = 'NO';
              if (field === 'isAutoIncrement' && value === true) {
                  newCol.key = 'PRI';
                  newCol.nullable = 'NO';
                  newCol.type = 'int'; // Suggest INT
              }
              if (field === 'type' && getDbType() === 'mysql' && !isMySQLCharacterColumnType(String(value))) {
                  newCol.charset = undefined;
                  newCol.collation = undefined;
              }
              return newCol;
          }
          return col;
      }));
  };

  const handleSaveColumnOptions = () => {
      if (!commentEditorColumnKey) {
          closeCommentEditor();
          return;
      }

      const isMySQL = getDbType() === 'mysql';
      const supportsCharacterOptions = isMySQL && isMySQLCharacterColumnType(commentEditorColumnType);
      const hasDefault = columnDefaultEnabled && (
          columnDefaultValue.length > 0 || isMySQLCharacterColumnType(commentEditorColumnType)
      );
      setColumns(prev => prev.map(col => {
          if (col._key !== commentEditorColumnKey) return col;
          return {
              ...col,
              comment: commentEditorValue,
              hasDefault,
              default: hasDefault ? columnDefaultValue : undefined,
              ...(isMySQL ? {
                  charset: supportsCharacterOptions ? columnCharset : undefined,
                  collation: supportsCharacterOptions ? columnCollation : undefined,
              } : {}),
          };
      }));
      closeCommentEditor();
  };

  const createNewColumn = useCallback((indexHint: number): EditableColumn => ({
      name: isNewTable ? 'new_column' : `new_col_${indexHint}`,
      type: 'varchar(255)',
      nullable: 'YES',
      key: '',
      extra: '',
      comment: '',
      default: undefined,
      hasDefault: false,
      _key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      isNew: true,
      isAutoIncrement: false
  }), [isNewTable]);

  const handleAddColumn = useCallback((insertAfterKey?: string) => {
      const newCol = createNewColumn(columns.length + 1);
      setColumns(prev => {
          const next = [...prev];
          if (insertAfterKey) {
              const insertIndex = next.findIndex(col => col._key === insertAfterKey);
              if (insertIndex >= 0) {
                  next.splice(insertIndex + 1, 0, newCol);
                  return next;
              }
          }
          next.push(newCol);
          return next;
      });
      setSelectedColumnRowKeys([newCol._key]);
      pendingFocusColumnKeyRef.current = newCol._key;
  }, [columns.length, createNewColumn]);

  const handleAddColumnAfterSelected = useCallback(() => {
      const selectedSet = new Set(selectedColumnRowKeys);
      const anchor = columns.find(col => selectedSet.has(col._key));
      if (!anchor) {
          message.warning(t('table_designer.message.select_column_before_insert', undefined, i18nLanguage));
          return;
      }
      handleAddColumn(anchor._key);
  }, [columns, handleAddColumn, i18nLanguage, selectedColumnRowKeys]);

  const handleDeleteColumn = (key: string) => {
      setColumns(prev => prev.filter(c => c._key !== key));
  };

  const isNativeColumnEditorTarget = (target: EventTarget | null): boolean => {
      const element = target instanceof HTMLElement ? target : null;
      return !!element?.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]');
  };

  const handleColumnClipboardCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (readOnly || selectedColumns.length === 0 || isNativeColumnEditorTarget(event.target)) return;
      event.clipboardData.setData('text/plain', serializeTableDesignerColumns(selectedColumns));
      event.preventDefault();
  };

  const handleColumnClipboardPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (readOnly || isNativeColumnEditorTarget(event.target)) return;
      const pastedColumns = parseTableDesignerColumns(event.clipboardData.getData('text/plain'));
      if (!pastedColumns || pastedColumns.length === 0) return;
      const nextColumns = cloneTableDesignerColumnsForPaste(pastedColumns, columns) as EditableColumn[];
      setColumns(prev => [...prev, ...nextColumns]);
      setSelectedColumnRowKeys(nextColumns.map(column => column._key));
      pendingFocusColumnKeyRef.current = nextColumns[0]._key || null;
      event.preventDefault();
  };

  const selectedColumns = useMemo(() => {
      if (selectedColumnRowKeys.length === 0) return [];
      const selectedSet = new Set(selectedColumnRowKeys);
      return columns.filter(col => selectedSet.has(col._key));
  }, [columns, selectedColumnRowKeys]);

  const groupedIndexes = useMemo<IndexDisplayRow[]>(() => {
      type IndexFieldItem = {
          name: string;
          seq: number;
          order: number;
      };
      type IndexBucket = {
          key: string;
          name: string;
          indexType: string;
          nonUnique: number;
          order: number;
          fields: IndexFieldItem[];
      };

      const buckets = new Map<string, IndexBucket>();

      const safeIndexes = Array.isArray(indexes) ? indexes : [];
      safeIndexes.forEach((idx, order) => {
          const rawName = String(idx.name || '').trim();
          const key = rawName || `__unnamed_${order}`;
          const indexType = String(idx.indexType || '').trim() || '-';
          const displayName = rawName || t('table_designer.fallback.unnamed_index', undefined, i18nLanguage);

          if (!buckets.has(key)) {
              buckets.set(key, {
                  key,
                  name: displayName,
                  indexType,
                  nonUnique: idx.nonUnique === 0 ? 0 : 1,
                  order,
                  fields: [],
              });
          }

          const bucket = buckets.get(key);
          if (!bucket) return;

          if (bucket.indexType === '-' && indexType !== '-') {
              bucket.indexType = indexType;
          }
          if (idx.nonUnique === 0) {
              bucket.nonUnique = 0;
          }

          const columnName = String(idx.columnName || '').trim();
          if (!columnName) return;

          const rawSeq = Number(idx.seqInIndex);
          const seq = Number.isFinite(rawSeq) ? rawSeq : 0;
          bucket.fields.push({
              name: columnName,
              seq,
              order,
          });
      });

      return Array.from(buckets.values())
          .sort((a, b) => a.order - b.order)
          .map((bucket) => {
              const sortedFieldNames = bucket.fields
                  .slice()
                  .sort((a, b) => {
                      const aSeq = a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
                      const bSeq = b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
                      if (aSeq !== bSeq) return aSeq - bSeq;
                      return a.order - b.order;
                  })
                  .map(field => field.name);

              const uniqueFieldNames = Array.from(new Set(sortedFieldNames));

              return {
                  key: bucket.key,
                  name: bucket.name,
                  indexType: bucket.indexType,
                  nonUnique: bucket.nonUnique,
                  columnNames: uniqueFieldNames,
              };
          });
  }, [i18nLanguage, indexes]);

  const selectedIndex = useMemo(() => {
      if (selectedIndexKeys.length === 0) return null;
      return groupedIndexes.find(idx => selectedIndexKeys.includes(idx.key)) || null;
  }, [selectedIndexKeys, groupedIndexes]);

  const groupedIndexFieldCount = useMemo(
      () => groupedIndexes.reduce((total, row) => total + row.columnNames.length, 0),
      [groupedIndexes]
  );

  const groupedForeignKeys = useMemo<ForeignKeyDisplayRow[]>(() => {
      type FieldItem = { name: string; order: number };
      type FkBucket = {
          key: string;
          constraintName: string;
          refTableName: string;
          order: number;
          columns: FieldItem[];
          refColumns: FieldItem[];
      };

      const buckets = new Map<string, FkBucket>();

      const safeFks = Array.isArray(fks) ? fks : [];
      safeFks.forEach((fk, order) => {
          const rawConstraint = String(fk.constraintName || fk.name || '').trim();
          const key = rawConstraint || `__unnamed_fk_${order}`;
          const constraintName = rawConstraint || t('table_designer.fallback.unnamed_foreign_key', undefined, i18nLanguage);
          const refTableName = String(fk.refTableName || '').trim() || '-';

          if (!buckets.has(key)) {
              buckets.set(key, {
                  key,
                  constraintName,
                  refTableName,
                  order,
                  columns: [],
                  refColumns: [],
              });
          }

          const bucket = buckets.get(key);
          if (!bucket) return;

          if (bucket.refTableName === '-' && refTableName !== '-') {
              bucket.refTableName = refTableName;
          }

          const colName = String(fk.columnName || '').trim();
          const refColName = String(fk.refColumnName || '').trim();
          if (colName) bucket.columns.push({ name: colName, order });
          if (refColName) bucket.refColumns.push({ name: refColName, order });
      });

      return Array.from(buckets.values())
          .sort((a, b) => a.order - b.order)
          .map((bucket) => {
              const columnNames = bucket.columns
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map(item => item.name);
              const refColumnNames = bucket.refColumns
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map(item => item.name);

              return {
                  key: bucket.key,
                  name: bucket.constraintName,
                  constraintName: bucket.constraintName,
                  refTableName: bucket.refTableName,
                  columnNames: Array.from(new Set(columnNames)),
                  refColumnNames: Array.from(new Set(refColumnNames)),
              };
          });
  }, [fks, i18nLanguage]);

  const localColumnOptions = useMemo(
      () => columns.map(col => ({ label: col.name, value: col.name })),
      [columns]
  );

  const isStarRocksNewTable = isNewTable && getDbType() === 'starrocks';
  const isTDengineNewTable = isNewTable && getDbType() === 'tdengine';
  const isTDengineChildNewTable = isTDengineNewTable && tdengineTableKind === 'child';
  const tdengineTagTypeOptions = useMemo(
      () => resolveColumnTypeOptions('tdengine').filter(option => option.value !== 'TIMESTAMP'),
      [],
  );

  useEffect(() => {
      if (isTDengineNewTable && (!tab.initialTab || tab.initialTab === 'columns')) {
          setActiveKey('tdengine');
      }
  }, [isTDengineNewTable, tab.initialTab]);

  useEffect(() => {
      if (!isTDengineChildNewTable) {
          setTdengineStableOptions([]);
          return;
      }
      let cancelled = false;
      const fetchSuperTables = async () => {
          setTdengineStableOptionsLoading(true);
          setTdengineStableOptions([]);
          try {
              const conn = connections.find(c => c.id === tab.connectionId);
              if (!conn) return;
              const config = {
                  ...conn.config,
                  port: Number(conn.config.port),
                  password: conn.config.password || "",
                  database: conn.config.database || "",
                  useSSH: conn.config.useSSH || false,
                  ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
              };
              const rpcConfig = buildRpcConnectionConfig(config) as any;
              const dbName = tab.dbName || '';
              for (const query of buildTDengineStableQueries(dbName)) {
                  const res = await DBQuery(rpcConfig, dbName, query);
                  if (cancelled) return;
                  if (!res?.success || !Array.isArray(res.data)) continue;
                  const options = buildTDengineStableOptions(res.data);
                  if (options.length > 0) {
                      setTdengineStableOptions(options);
                      return;
                  }
              }
              if (!cancelled) setTdengineStableOptions([]);
          } catch {
              if (!cancelled) setTdengineStableOptions([]);
          } finally {
              if (!cancelled) setTdengineStableOptionsLoading(false);
          }
      };
      fetchSuperTables();
      return () => { cancelled = true; };
  }, [isTDengineChildNewTable, tab.connectionId, tab.dbName, connections]);

	  useEffect(() => {
	      if (!isTDengineChildNewTable || !tdengineStableName.trim()) {
	          setTdengineChildTagDefs([]);
	          setTdengineChildTagValues({});
	          return;
	      }
	      let cancelled = false;
	      const fetchTagDefs = async () => {
	          setTdengineChildTagDefsLoading(true);
	          try {
	              const conn = connections.find(c => c.id === tab.connectionId);
	              if (!conn) return;
	              const config = {
	                  ...conn.config,
	                  port: Number(conn.config.port),
	                  password: conn.config.password || "",
	                  database: conn.config.database || "",
	                  useSSH: conn.config.useSSH || false,
	                  ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
	              };
	              const rpcConfig = buildRpcConnectionConfig(config) as any;
	              const dbName = tab.dbName || '';
	              const res = await DBGetColumns(rpcConfig, dbName, tdengineStableName.trim());
	              if (cancelled) return;
	              if (res.success && Array.isArray(res.data)) {
	                  const tagDefs: TDengineTagDraft[] = res.data
	                      .filter((col: any) => (col?.key || col?.Key || '') === 'TAG')
	                      .map((col: any, idx: number) => ({
	                          _key: `tagdef-${idx}`,
	                          name: String(col?.name || col?.Name || ''),
	                          type: String(col?.type || col?.Type || ''),
	                      }));
	                  setTdengineChildTagDefs(tagDefs);
	                  setTdengineChildTagValues({});
	              } else {
	                  setTdengineChildTagDefs([]);
	                  setTdengineChildTagValues({});
	              }
	          } catch {
	              if (!cancelled) {
	                  setTdengineChildTagDefs([]);
	                  setTdengineChildTagValues({});
	              }
	          } finally {
	              if (!cancelled) setTdengineChildTagDefsLoading(false);
	          }
	      };
	      fetchTagDefs();
	      return () => { cancelled = true; };
	  }, [isTDengineChildNewTable, tdengineStableName, tab.connectionId, tab.dbName, connections]);

  const parseStarRocksRollupOptions = (raw: string): StarRocksCreateTableOptions['rollups'] => (
      String(raw || '')
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => {
              const [namePart, columnsPart] = line.split(':');
              const name = String(namePart || '').trim();
              const columnNames = String(columnsPart || '')
                  .split(',')
                  .map(item => item.trim())
                  .filter(Boolean);
              return { name, columnNames };
          })
          .filter(item => item.name && item.columnNames.length > 0)
  );

  const buildStarRocksCreateOptions = (): StarRocksCreateTableOptions | undefined => {
      if (!isStarRocksNewTable) return undefined;
      return {
          tableKind: starRocksTableKind,
          keyModel: starRocksKeyModel,
          keyColumnNames: starRocksKeyColumns,
          partitionClause: starRocksPartitionClause,
          distributionType: starRocksDistributionType,
          distributionColumnNames: starRocksDistributionColumns,
          bucketMode: starRocksBucketMode,
          bucketCount: Number(starRocksBucketCount) || undefined,
          properties: starRocksProperties,
          rollups: parseStarRocksRollupOptions(starRocksRollups),
          externalEngine: starRocksExternalEngine,
          externalProperties: starRocksExternalProperties,
      };
  };

  const buildTDengineCreateOptions = (): TDengineCreateTableOptions | undefined => {
      if (!isTDengineNewTable) return undefined;
      let tagValues = tdengineTagValues;
      if (tdengineTableKind === 'child' && tdengineChildTagDefs.length > 0) {
          tagValues = tdengineChildTagDefs
              .map(tag => {
                  const val = tdengineChildTagValues[tag.name] ?? '';
                  if (!val) return '';
                  const needQuote = /^(BINARY|NCHAR|VARBINARY|TIMESTAMP)/i.test(tag.type);
                  return needQuote ? `'${val.replace(/'/g, "\\'")}'` : val;
              })
              .filter(Boolean)
              .join(', ');
      }
      return {
          tableKind: tdengineTableKind,
          stableName: tdengineStableName,
          tagDefinitions: tdengineTagDefinitions.map(({ _key, ...tag }) => tag),
          tagValues,
      };
  };

  useEffect(() => {
      if (selectedIndexKeys.length === 0) return;
      const validKeys = selectedIndexKeys.filter(key => groupedIndexes.some(idx => idx.key === key));
      if (validKeys.length !== selectedIndexKeys.length) {
          setSelectedIndexKeys(validKeys);
      }
  }, [groupedIndexes, selectedIndexKeys]);

  useEffect(() => {
      if (!selectedForeignKey) return;
      if (!groupedForeignKeys.some(fk => fk.key === selectedForeignKey.key)) {
          setSelectedForeignKey(null);
      }
  }, [groupedForeignKeys, selectedForeignKey]);

  const escapeBacktickIdentifier = (name: string) => String(name || '').replace(/`/g, '``');
  const escapeBracketIdentifier = (name: string) => String(name || '').replace(/]/g, ']]');
  const escapeDoubleQuoteIdentifier = (name: string) => String(name || '').replace(/"/g, '""');
  const escapeSqlString = (value: string) => String(value || '').replace(/'/g, "''");

  const splitQualifiedName = (qualifiedName: string): { schemaName: string; objectName: string } => {
      const parsed = splitQualifiedNameLast(qualifiedName);
      return {
          schemaName: parsed.parentPath,
          objectName: parsed.objectName,
      };
  };

  const isPgLikeDialect = (dbType: string): boolean => isPgLikeSqlDialect(dbType);
  const isOracleLikeDialect = (dbType: string): boolean => isOracleLikeSqlDialect(dbType);
  const isSqlServerDialect = (dbType: string): boolean => isSqlServerSqlDialect(dbType);
  const isMysqlLikeDialect = (dbType: string): boolean => isMysqlFamilySqlDialect(dbType);
  const isNonRelationalDialect = (dbType: string): boolean => dbType === 'redis' || dbType === 'mongodb' || dbType === 'elasticsearch';
  const lacksAlterForeignKeySupport = (dbType: string): boolean => dbType === 'sqlite' || dbType === 'duckdb' || dbType === 'tdengine';
  const lacksTableCommentSupport = (dbType: string): boolean => dbType === 'sqlite';

  const quoteIdentifierPartByDialect = (part: string, dbType: string): string => {
      return quoteSqlIdentifierPart(dbType, part);
  };

  const quoteIdentifierPathByDialect = (path: string, dbType: string): string => {
      return quoteSqlIdentifierPath(dbType, path);
  };

  const resolveTableInfo = () => {
      const dbType = getDbType();
      const resolved = resolveTableDesignerEditTarget({
          dbType,
          dbName: String(tab.dbName || ''),
          tableName: String(tab.tableName || ''),
          selectedSchema,
          schemaSelectionOverride,
      });
      return {
          dbType,
          ...resolved,
          tableRef: quoteIdentifierPathByDialect(resolved.qualifiedName, dbType),
      };
  };

  const hasUnsavedDraftChanges = useMemo(() => {
      if (isNewTable || readOnly) {
          return false;
      }
      const tableInfo = resolveTableInfo();
      return hasAlterTableDraftChanges({
          dbType: tableInfo.dbType,
          tableName: tableInfo.qualifiedName,
          originalColumns,
          columns,
      });
  }, [columns, connections, isNewTable, originalColumns, readOnly, schemaSelectionOverride, selectedSchema, tab.connectionId, tab.dbName, tab.tableName]);

  const supportsIndexSchemaOps = (): boolean => {
      const dbType = getDbType();
      if (!dbType) return false;
      if (isNonRelationalDialect(dbType)) return false;
      return true;
  };

  const supportsForeignKeySchemaOps = (): boolean => {
      const dbType = getDbType();
      if (!dbType) return false;
      if (isNonRelationalDialect(dbType)) return false;
      if (lacksAlterForeignKeySupport(dbType)) return false;
      return true;
  };

  const supportsTableCommentOps = (): boolean => {
      const dbType = getDbType();
      if (!dbType) return false;
      if (isNonRelationalDialect(dbType)) return false;
      if (lacksTableCommentSupport(dbType)) return false;
      return true;
  };

  const getIndexKindOptions = () => {
      const dbType = getDbType();
      if (isMysqlLikeDialect(dbType)) {
          return [
              { label: t('table_designer.index.kind.normal_nonclustered', undefined, i18nLanguage), value: 'NORMAL' },
              { label: t('table_designer.index.kind.unique', undefined, i18nLanguage), value: 'UNIQUE' },
              { label: t('table_designer.index.kind.primary_clustered', undefined, i18nLanguage), value: 'PRIMARY' },
              { label: t('table_designer.index.kind.fulltext', undefined, i18nLanguage), value: 'FULLTEXT' },
              { label: t('table_designer.index.kind.spatial', undefined, i18nLanguage), value: 'SPATIAL' },
          ];
      }
      return [
          { label: t('table_designer.index.kind.normal', undefined, i18nLanguage), value: 'NORMAL' },
          { label: t('table_designer.index.kind.unique', undefined, i18nLanguage), value: 'UNIQUE' },
      ];
  };

  const getIndexTypeOptions = (kind?: IndexKind) => {
      const dbType = getDbType();
      const k = kind || 'NORMAL';
      if (isMysqlLikeDialect(dbType)) {
          // MySQL InnoDB: 所有索引均为固定方法类型
          if (k === 'FULLTEXT') return [{ label: 'FULLTEXT', value: 'FULLTEXT' }];
          if (k === 'SPATIAL') return [{ label: 'RTREE', value: 'RTREE' }];
          return [{ label: 'BTREE', value: 'BTREE' }];
      }
      if (isPgLikeDialect(dbType)) {
          if (k === 'PRIMARY' || k === 'UNIQUE') return [{ label: 'BTREE', value: 'BTREE' }];
          return PGLIKE_INDEX_TYPE_OPTIONS.map(option => option.value === 'DEFAULT'
              ? { ...option, label: t('table_designer.option.default', undefined, i18nLanguage) }
              : option);
      }
      if (isSqlServerDialect(dbType)) {
          return SQLSERVER_INDEX_TYPE_OPTIONS.map(option => option.value === 'DEFAULT'
              ? { ...option, label: t('table_designer.option.default', undefined, i18nLanguage) }
              : option);
      }
      return [{ label: t('table_designer.option.default', undefined, i18nLanguage), value: 'DEFAULT' }];
  };

  /** 根据索引类别返回固定的索引方法类型，可选类别返回 undefined */
  const getFixedIndexType = (kind: IndexKind): string | undefined => {
      const dbType = getDbType();
      if (isMysqlLikeDialect(dbType)) {
          if (kind === 'PRIMARY') return 'BTREE';
          if (kind === 'FULLTEXT') return 'FULLTEXT';
          if (kind === 'SPATIAL') return 'RTREE';
      }
      if (isPgLikeDialect(dbType)) {
          if (kind === 'PRIMARY') return 'BTREE';
      }
      return undefined;
  };

  const buildCreateTableSql = (targetTableName: string, targetColumns: EditableColumn[], targetCharset: string, targetCollation: string) => {
      const dbType = getDbType();
      return buildCreateTablePreviewSql({
          dbType,
          tableName: qualifyTableDesignerCreateName(targetTableName, selectedSchema, dbType),
          columns: targetColumns,
          charset: targetCharset,
          collation: targetCollation,
          starRocksOptions: buildStarRocksCreateOptions(),
          tdengineOptions: buildTDengineCreateOptions(),
          translate: (key, params) => t(key, params, i18nLanguage),
      });
  };

  const openCopySelectedColumnsModal = () => {
      if (selectedColumns.length === 0) {
          message.warning(t('table_designer.message.select_columns_to_copy', undefined, i18nLanguage));
          return;
      }
      const sourceName = (tab.tableName || 'new_table').trim();
      setCopyTableName(`${sourceName}_copy`);
      setCopyCharset(charset);
      const charsetCollations = (COLLATIONS as any)[charset] || [];
      setCopyCollation(
          charsetCollations.some((item: any) => item.value === collation)
              ? collation
              : (charsetCollations[0]?.value || 'utf8mb4_unicode_ci')
      );
      setIsCopyColumnsModalOpen(true);
  };

  const handleExecuteCopySelectedColumns = async () => {
      if (!copyTableName.trim()) {
          message.error(t('table_designer.message.target_table_required', undefined, i18nLanguage));
          return;
      }
      if (selectedColumns.length === 0) {
          message.error(t('table_designer.message.no_copyable_columns', undefined, i18nLanguage));
          return;
      }
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) {
          message.error(t('table_designer.message.connection_not_found', undefined, i18nLanguage));
          return;
      }
      const approved = await confirmProductionRisk({
          connection: conn,
          action: t('connection.production_risk.action.execute_sql'),
          target: [
              tab.dbName,
              supportsTableDesignerSchemaSelection ? designerSchemaTitle : '',
              copyTableName.trim(),
          ].filter(Boolean).join(' / '),
          translate: (key, params) => t(key, params, i18nLanguage),
      });
      if (!approved) return;
      const sql = buildCreateTableSql(copyTableName.trim(), selectedColumns, copyCharset, copyCollation);
      setCopyExecuting(true);
      try {
          const result = await executeSchemaStatements(sql, {
              skipProductionRiskConfirm: true,
          });
          if (result.ok) {
              message.success(t('table_designer.message.columns_copied_to_new_table', { count: selectedColumns.length, table: copyTableName.trim() }, i18nLanguage));
              setIsCopyColumnsModalOpen(false);
          } else {
              message.error(t('table_designer.message.execution_failed', {
                  detail: result.rawMessage || result.message,
              }, i18nLanguage));
          }
      } finally {
          setCopyExecuting(false);
      }
  };

  const executeSchemaStatements = async (
      sqlText: string,
      options: SchemaExecutionOptions = {},
  ): Promise<SchemaExecutionResult> => {
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) {
          return { ok: false, message: t('table_designer.message.connection_not_found', undefined, i18nLanguage), statementCount: 0 };
      }
      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
      const dbType = resolveTableInfo().dbType;
      const statements = options.splitStatements === false
          ? (String(sqlText || '').trim() && splitSchemaExecutionStatements(sqlText, dbType).length > 0 ? [sqlText] : [])
          : splitSchemaExecutionStatements(sqlText, dbType);
      const refreshSchemaConsumers = () => {
          dispatchSidebarDatabaseRefresh({
              connectionId: tab.connectionId,
              dbName: tab.dbName || '',
          });
      };
      if (
          !options.skipProductionRiskConfirm
          && findPotentiallyMutatingConnectionStatements(conn.config, sqlText).length > 0
      ) {
          const approved = await confirmProductionRisk({
              connection: conn,
              action: t('connection.production_risk.action.execute_sql'),
              target: [tab.dbName, supportsTableDesignerSchemaSelection ? designerSchemaTitle : '', tab.tableName].filter(Boolean).join(' / '),
              translate: (key, params) => t(key, params, i18nLanguage),
          });
          if (!approved) {
              return { ok: false, cancelled: true, statementCount: statements.length };
          }
      }
      const result = await executeTableDesignerSchemaStatements({
          sqlText,
          dbType,
          execute: (statement) => DBQueryAudited(
              buildRpcConnectionConfig(config) as any,
              tab.dbName || '',
              statement,
              'table_designer',
          ),
          refreshSchemaConsumers,
          emptySqlMessage: t('table_designer.message.no_sql_statement', undefined, i18nLanguage),
          splitStatements: options.splitStatements,
      });
      if (result.ok) return result;

      const failedStatementIndex = result.failedStatementIndex ?? 0;
      const prefix = statements.length > 1
          ? t('table_designer.message.statement_execution_failed_prefix', {
              current: failedStatementIndex + 1,
              total: statements.length,
          }, i18nLanguage)
          : t('table_designer.message.execution_failed_prefix', undefined, i18nLanguage);
      return {
          ...result,
          rawMessage: result.message,
          message: prefix + String(result.message || ''),
      };
  };

  const buildIndexFormFromRow = (row: IndexDisplayRow): IndexFormState => {
      return normalizeIndexFormFromRow(
          row as IndexDisplaySnapshot,
          getIndexKindOptions().map(item => item.value as IndexKind),
      );
  };

  const executeIndexEditSql = async (dropSql: string, addSql: string, previousIndex: IndexDisplayRow): Promise<boolean> => {
      const result = await executeSchemaStatements(`${dropSql}\n${addSql}`);
      if (result.cancelled) return false;
      if (result.ok) {
          await fetchData();
          message.success(t('table_designer.message.index_updated', undefined, i18nLanguage));
          return true;
      }

      const oldCreateSql = buildIndexCreateSql(buildIndexFormFromRow(previousIndex));
      if (!oldCreateSql) {
          message.error(t('table_designer.message.index_restore_unavailable', { detail: result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage) }, i18nLanguage));
          await fetchData();
          return false;
      }

      if (!shouldRestoreOriginalIndex(result)) {
          message.error(result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage));
          if (result.schemaMayHaveChanged) await fetchData();
          return false;
      }

      const restoreResult = await executeSchemaStatements(oldCreateSql, {
          skipProductionRiskConfirm: true,
      });
      if (restoreResult.ok) {
          message.error(t('table_designer.message.index_restored_after_failure', { detail: result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage) }, i18nLanguage));
      } else {
          message.error(t('table_designer.message.index_restore_failed', {
              detail: result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage),
              restoreDetail: restoreResult.message || t('table_designer.fallback.unknown_error', undefined, i18nLanguage),
          }, i18nLanguage));
      }
      await fetchData();
      return false;
  };

  const executeSchemaSql = async (sql: string, successMessage: string): Promise<boolean> => {
      try {
          const result = await executeSchemaStatements(sql);
          if (!result.ok) {
              if (result.cancelled) return false;
              message.error(result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage));
              if (result.schemaMayHaveChanged) await fetchData();
              return false;
          }
          await fetchData();
          message.success(successMessage);
          return true;
      } catch (e: any) {
          message.error(t('table_designer.message.execution_failed', { detail: e?.message || String(e) }, i18nLanguage));
          return false;
      }
  };

  const openTableCommentModal = () => {
      setTableCommentDraft(tableComment || '');
      setIsTableCommentModalOpen(true);
  };

  const buildTableCommentSql = (nextComment: string): string | null => {
      const tableInfo = resolveTableInfo();
      const dbType = tableInfo.dbType;
      const escapedComment = escapeSqlString(nextComment);
      if (isNonRelationalDialect(dbType)) return null;
      if (isMysqlLikeDialect(dbType)) {
          return `ALTER TABLE ${tableInfo.tableRef} COMMENT = '${escapedComment}';`;
      }
      if (isPgLikeDialect(dbType) || isOracleLikeDialect(dbType)) {
          return `COMMENT ON TABLE ${tableInfo.tableRef} IS '${escapedComment}';`;
      }
      if (isSqlServerDialect(dbType)) {
          const schemaName = escapeSqlString(tableInfo.schema || 'dbo');
          const tableName = escapeSqlString(tableInfo.table);
          return `IF EXISTS (
    SELECT 1
    FROM sys.extended_properties ep
    JOIN sys.tables t ON ep.major_id = t.object_id AND ep.minor_id = 0
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE ep.name = N'MS_Description'
      AND s.name = N'${schemaName}'
      AND t.name = N'${tableName}'
)
BEGIN
    EXEC sp_updateextendedproperty
        @name = N'MS_Description',
        @value = N'${escapedComment}',
        @level0type = N'SCHEMA', @level0name = N'${schemaName}',
        @level1type = N'TABLE', @level1name = N'${tableName}';
END
ELSE
BEGIN
    EXEC sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'${escapedComment}',
        @level0type = N'SCHEMA', @level0name = N'${schemaName}',
        @level1type = N'TABLE', @level1name = N'${tableName}';
END;`;
      }
      return `COMMENT ON TABLE ${tableInfo.tableRef} IS '${escapedComment}';`;
  };

  const handleSaveTableComment = async () => {
      if (!supportsTableCommentOps()) {
          message.warning(t('table_designer.message.table_comment_unsupported', undefined, i18nLanguage));
          return;
      }
      if (!tab.tableName) return;
      const sql = buildTableCommentSql(tableCommentDraft);
      if (!sql) {
          message.warning(t('table_designer.message.table_comment_unsupported', undefined, i18nLanguage));
          return;
      }
      setTableCommentSaving(true);
      const ok = await executeSchemaSql(sql, t('table_designer.message.table_comment_updated', undefined, i18nLanguage));
      setTableCommentSaving(false);
      if (ok) {
          setTableComment(tableCommentDraft);
          setIsTableCommentModalOpen(false);
      }
  };

  const openCreateIndexModal = () => {
      setIndexModalMode('create');
      setIndexForm({
          name: '',
          columnNames: [],
          kind: 'NORMAL',
          indexType: 'DEFAULT',
      });
      setIsIndexModalOpen(true);
  };

  const openEditIndexModal = () => {
      if (!selectedIndex) {
          message.warning(t('table_designer.message.select_one_index', undefined, i18nLanguage));
          return;
      }
      setIndexModalMode('edit');
      setIndexForm(buildIndexFormFromRow(selectedIndex));
      setIsIndexModalOpen(true);
  };

  const getIndexCreateSqlResult = (form: IndexFormState) => {
      const tableInfo = resolveTableInfo();
      return buildIndexCreateSqlPreview({
          dbType: tableInfo.dbType,
          tableRef: tableInfo.tableRef,
          name: form.name,
          columnNames: form.columnNames,
          kind: form.kind,
          indexType: form.indexType,
          translate: (key, params) => t(key, params, i18nLanguage),
      });
  };

  const buildIndexCreateSql = (form: IndexFormState): string | null => {
      const result = getIndexCreateSqlResult(form);
      if (!result.sql) {
          if (result.severity === 'warning') {
              message.warning(result.message || t('table_designer.message.index_create_sql_unavailable', undefined, i18nLanguage));
          } else {
              message.error(result.message || t('table_designer.message.index_create_sql_unavailable', undefined, i18nLanguage));
          }
          return null;
      }
      return result.sql;
  };

  const indexCreatePreviewSql = useMemo(() => {
      if (!isIndexModalOpen) return '';
      const result = getIndexCreateSqlResult(indexForm);
      return result.sql || `-- ${result.message || 'Index CREATE SQL placeholder unavailable'}`;
  }, [connections, i18nLanguage, indexForm, isIndexModalOpen, schemaSelectionOverride, selectedSchema, tab.connectionId, tab.dbName, tab.tableName]);

  const selectedIndexCreateSql = useMemo(() => {
      if (!selectedIndex || selectedIndexKeys.length !== 1) return '';
      const result = getIndexCreateSqlResult(buildIndexFormFromRow(selectedIndex));
      return result.sql || `-- ${result.message || 'Index CREATE SQL unavailable'}`;
  }, [connections, i18nLanguage, schemaSelectionOverride, selectedIndex, selectedIndexKeys.length, selectedSchema, tab.connectionId, tab.dbName, tab.tableName]);

  const indexTableHeight = selectedIndexCreateSql ? Math.max(180, tableHeight - 220) : tableHeight;

  const buildIndexDropSql = (indexName: string): string | null => {
      const tableInfo = resolveTableInfo();
      const dbType = tableInfo.dbType;
      const name = String(indexName || '').trim();
      if (!name) return null;

      if (isMysqlLikeDialect(dbType)) {
          if (name.toUpperCase() === 'PRIMARY') {
              return `ALTER TABLE ${tableInfo.tableRef}\nDROP PRIMARY KEY;`;
          }
          const indexRef = quoteIdentifierPartByDialect(name, dbType);
          return `DROP INDEX ${indexRef} ON ${tableInfo.tableRef};`;
      }

      if (isSqlServerDialect(dbType)) {
          const indexRef = quoteIdentifierPartByDialect(name, dbType);
          return `DROP INDEX ${indexRef} ON ${tableInfo.tableRef};`;
      }

      if (isPgLikeDialect(dbType) || isOracleLikeDialect(dbType) || dbType === 'sqlite') {
          const fullIndexName = name.includes('.') || !tableInfo.schema
              ? name
              : `${tableInfo.schema}.${name}`;
          const indexRef = quoteIdentifierPathByDialect(fullIndexName, dbType);
          return `DROP INDEX ${indexRef};`;
      }

      if (isNonRelationalDialect(dbType)) {
          return null;
      }
      const fullIndexName = name.includes('.') || !tableInfo.schema
          ? name
          : `${tableInfo.schema}.${name}`;
      const indexRef = quoteIdentifierPathByDialect(fullIndexName, dbType);
      return `DROP INDEX ${indexRef};`;
  };

  const handleSubmitIndex = async () => {
      if (!supportsIndexSchemaOps()) {
          message.warning(t('table_designer.message.index_maintenance_unsupported', undefined, i18nLanguage));
          return;
      }
      if (!tab.tableName) return;
      const supportedKinds = new Set(getIndexKindOptions().map(item => item.value));
      if (!supportedKinds.has(indexForm.kind)) {
          message.warning(t('table_designer.message.index_kind_unsupported', undefined, i18nLanguage));
          return;
      }
      const nextName = indexForm.kind === 'PRIMARY' ? 'PRIMARY' : String(indexForm.name || '').trim();
      if (indexForm.kind !== 'PRIMARY' && !nextName) {
          message.error(t('table_designer.message.index_name_required', undefined, i18nLanguage));
          return;
      }
      if (indexForm.columnNames.length === 0) {
          message.error(t('table_designer.message.select_at_least_one_column', undefined, i18nLanguage));
          return;
      }

      const upperName = nextName.toUpperCase();
      const duplicate = groupedIndexes.some(idx => {
          if (indexModalMode === 'edit' && selectedIndex && idx.key === selectedIndex.key) return false;
          return idx.name.toUpperCase() === upperName;
      });
      if (duplicate) {
          message.error(t('table_designer.message.index_name_exists', { name: nextName }, i18nLanguage));
          return;
      }

      setIndexSaving(true);
      const addSql = buildIndexCreateSql({ ...indexForm, name: nextName });
      if (!addSql) {
          setIndexSaving(false);
          return;
      }
      let sql = addSql;

      if (indexModalMode === 'edit' && selectedIndex) {
          const previousForm = buildIndexFormFromRow(selectedIndex);
          const nextForm: IndexFormState = {
              name: indexForm.kind === 'PRIMARY' ? 'PRIMARY' : nextName,
              columnNames: [...indexForm.columnNames],
              kind: indexForm.kind,
              indexType: indexForm.kind === 'NORMAL' || indexForm.kind === 'UNIQUE'
                  ? (String(indexForm.indexType || '').trim().toUpperCase() || 'DEFAULT')
                  : 'DEFAULT',
          };
          if (!hasIndexFormChanged(previousForm, nextForm)) {
              setIndexSaving(false);
              message.info(t('table_designer.message.no_index_changes', undefined, i18nLanguage));
              return;
          }
          const dropSql = buildIndexDropSql(selectedIndex.name);
          if (!dropSql) {
              setIndexSaving(false);
              message.warning(t('table_designer.message.index_delete_unsupported', undefined, i18nLanguage));
              return;
          }
          const ok = await executeIndexEditSql(dropSql, addSql, selectedIndex);
          setIndexSaving(false);
          if (ok) {
              setIsIndexModalOpen(false);
          }
          return;
      }

      const ok = await executeSchemaSql(
          sql,
          indexModalMode === 'create'
              ? t('table_designer.message.index_created', undefined, i18nLanguage)
              : t('table_designer.message.index_updated', undefined, i18nLanguage),
      );
      setIndexSaving(false);
      if (ok) {
          setIsIndexModalOpen(false);
      }
  };

  const handleDeleteIndex = () => {
      if (selectedIndexKeys.length === 0) {
          message.warning(t('table_designer.message.select_index_to_delete', undefined, i18nLanguage));
          return;
      }
      if (!supportsIndexSchemaOps()) {
          message.warning(t('table_designer.message.index_maintenance_unsupported', undefined, i18nLanguage));
          return;
      }
      // 根据选中的 key 找到对应的索引对象
      const toDelete = groupedIndexes.filter(idx => selectedIndexKeys.includes(idx.key));
      if (toDelete.length === 0) {
          message.warning(t('table_designer.message.select_index_to_delete', undefined, i18nLanguage));
          return;
      }
      const names = toDelete.map(idx => `"${idx.name}"`).join(', ');
      Modal.confirm({
          title: t('table_designer.modal.delete_index_title', undefined, i18nLanguage),
          icon: <ExclamationCircleOutlined />,
          content: toDelete.length === 1
              ? t('table_designer.modal.delete_index_one', { names }, i18nLanguage)
              : t('table_designer.modal.delete_index_many', { count: toDelete.length, names }, i18nLanguage),
          okText: t('table_designer.action.delete', undefined, i18nLanguage),
          okType: 'danger',
          cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
          onOk: async () => {
              const sqls: string[] = [];
              for (const idx of toDelete) {
                  const sql = buildIndexDropSql(idx.name);
                  if (!sql) {
                      message.warning(t('table_designer.message.index_delete_named_unsupported', { name: idx.name }, i18nLanguage));
                      return;
                  }
                  sqls.push(sql);
              }
              const ok = await executeSchemaSql(
                  sqls.join('\n'),
                  toDelete.length === 1
                      ? t('table_designer.message.index_deleted', undefined, i18nLanguage)
                      : t('table_designer.message.indexes_deleted', { count: toDelete.length }, i18nLanguage),
              );
              if (ok) {
                  setSelectedIndexKeys([]);
              }
          }
      });
  };

  const openCreateForeignKeyModal = () => {
      setForeignKeyModalMode('create');
      setForeignKeyForm({
          constraintName: '',
          columnNames: [],
          refTableName: '',
          refColumnNames: [],
      });
      setIsForeignKeyModalOpen(true);
  };

  const openEditForeignKeyModal = () => {
      if (!selectedForeignKey) {
          message.warning(t('table_designer.message.select_one_foreign_key', undefined, i18nLanguage));
          return;
      }
      setForeignKeyModalMode('edit');
      setForeignKeyForm({
          constraintName: selectedForeignKey.constraintName,
          columnNames: [...selectedForeignKey.columnNames],
          refTableName: selectedForeignKey.refTableName === '-' ? '' : selectedForeignKey.refTableName,
          refColumnNames: [...selectedForeignKey.refColumnNames],
      });
      setIsForeignKeyModalOpen(true);
  };

  const buildForeignKeyAddSql = (form: ForeignKeyFormState): string | null => {
      const tableInfo = resolveTableInfo();
      const dbType = tableInfo.dbType;
      if (!supportsForeignKeySchemaOps()) return null;

      const localColsSql = form.columnNames
          .map(col => quoteIdentifierPartByDialect(col, dbType))
          .join(', ');
      const refColsSql = form.refColumnNames
          .map(col => quoteIdentifierPartByDialect(col, dbType))
          .join(', ');
      const refParts = splitQualifiedName(form.refTableName);
      const refObjectName = refParts.objectName || String(form.refTableName || '').trim();
      const refTableName = !refParts.schemaName && tableInfo.schema && (isPgLikeDialect(dbType) || isSqlServerDialect(dbType) || isOracleLikeDialect(dbType))
          ? `${tableInfo.schema}.${refObjectName}`
          : String(form.refTableName || '').trim();
      const refTableSql = quoteIdentifierPathByDialect(refTableName, dbType);
      const constraintSql = quoteIdentifierPartByDialect(form.constraintName, dbType);
      return `ALTER TABLE ${tableInfo.tableRef}\nADD CONSTRAINT ${constraintSql} FOREIGN KEY (${localColsSql}) REFERENCES ${refTableSql} (${refColsSql});`;
  };

  const buildForeignKeyDropSql = (constraintName: string): string | null => {
      const tableInfo = resolveTableInfo();
      const dbType = tableInfo.dbType;
      if (!supportsForeignKeySchemaOps()) return null;
      const constraintSql = quoteIdentifierPartByDialect(constraintName, dbType);
      if (isMysqlLikeDialect(dbType)) {
          return `ALTER TABLE ${tableInfo.tableRef}\nDROP FOREIGN KEY ${constraintSql};`;
      }
      return `ALTER TABLE ${tableInfo.tableRef}\nDROP CONSTRAINT ${constraintSql};`;
  };

  const handleSubmitForeignKey = async () => {
      if (!supportsForeignKeySchemaOps()) {
          message.warning(t('table_designer.message.foreign_key_maintenance_unsupported', undefined, i18nLanguage));
          return;
      }
      if (!tab.tableName) return;
      const nextConstraint = String(foreignKeyForm.constraintName || '').trim();
      const refTable = String(foreignKeyForm.refTableName || '').trim();
      const refCols = foreignKeyForm.refColumnNames.map(v => String(v || '').trim()).filter(Boolean);
      const localCols = foreignKeyForm.columnNames.map(v => String(v || '').trim()).filter(Boolean);

      if (!nextConstraint) {
          message.error(t('table_designer.message.foreign_key_name_required', undefined, i18nLanguage));
          return;
      }
      if (localCols.length === 0) {
          message.error(t('table_designer.message.select_local_columns', undefined, i18nLanguage));
          return;
      }
      if (!refTable) {
          message.error(t('table_designer.message.ref_table_required', undefined, i18nLanguage));
          return;
      }
      if (refCols.length === 0) {
          message.error(t('table_designer.message.ref_columns_required', undefined, i18nLanguage));
          return;
      }
      if (localCols.length !== refCols.length) {
          message.error(t('table_designer.message.foreign_key_column_count_mismatch', undefined, i18nLanguage));
          return;
      }

      const duplicate = groupedForeignKeys.some(item => {
          if (foreignKeyModalMode === 'edit' && selectedForeignKey && item.key === selectedForeignKey.key) return false;
          return item.constraintName.toUpperCase() === nextConstraint.toUpperCase();
      });
      if (duplicate) {
          message.error(t('table_designer.message.foreign_key_name_exists', { name: nextConstraint }, i18nLanguage));
          return;
      }

      setForeignKeySaving(true);
      const addSql = buildForeignKeyAddSql({
          ...foreignKeyForm,
          constraintName: nextConstraint,
          columnNames: localCols,
          refTableName: refTable,
          refColumnNames: refCols,
      });
      if (!addSql) {
          setForeignKeySaving(false);
          message.warning(t('table_designer.message.foreign_key_maintenance_unsupported', undefined, i18nLanguage));
          return;
      }
      let sql = addSql;
      if (foreignKeyModalMode === 'edit' && selectedForeignKey) {
          const dropSql = buildForeignKeyDropSql(selectedForeignKey.constraintName);
          if (!dropSql) {
              setForeignKeySaving(false);
              message.warning(t('table_designer.message.foreign_key_delete_unsupported', undefined, i18nLanguage));
              return;
          }
          sql = `${dropSql}\n${addSql}`;
      }

      const ok = await executeSchemaSql(
          sql,
          foreignKeyModalMode === 'create'
              ? t('table_designer.message.foreign_key_created', undefined, i18nLanguage)
              : t('table_designer.message.foreign_key_updated', undefined, i18nLanguage),
      );
      setForeignKeySaving(false);
      if (ok) {
          setIsForeignKeyModalOpen(false);
      }
  };

  const handleDeleteForeignKey = () => {
      if (!selectedForeignKey) {
          message.warning(t('table_designer.message.select_one_foreign_key', undefined, i18nLanguage));
          return;
      }
      if (!supportsForeignKeySchemaOps()) {
          message.warning(t('table_designer.message.foreign_key_maintenance_unsupported', undefined, i18nLanguage));
          return;
      }
      Modal.confirm({
          title: t('table_designer.modal.delete_foreign_key_title', undefined, i18nLanguage),
          icon: <ExclamationCircleOutlined />,
          content: t('table_designer.modal.delete_foreign_key_content', { name: selectedForeignKey.constraintName }, i18nLanguage),
          okText: t('table_designer.action.delete', undefined, i18nLanguage),
          okType: 'danger',
          cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
          onOk: async () => {
              const sql = buildForeignKeyDropSql(selectedForeignKey.constraintName);
              if (!sql) {
                  message.warning(t('table_designer.message.foreign_key_delete_unsupported', undefined, i18nLanguage));
                  return;
              }
              await executeSchemaSql(sql, t('table_designer.message.foreign_key_deleted', undefined, i18nLanguage));
          }
      });
  };

  const onDragEnd = ({ active, over }: any) => {
    if (active.id !== over?.id) {
      setColumns((previous) => {
        const activeIndex = previous.findIndex((i) => i._key === active.id);
        const overIndex = previous.findIndex((i) => i._key === over?.id);
        return arrayMove(previous, activeIndex, overIndex);
      });
    }
  };

  const generateDDL = () => {
      if (isNewTable && !newTableName.trim()) {
          message.error(t('table_designer.message.table_name_required', undefined, i18nLanguage));
          return;
      }
      if (isNewTable && isTDengineChildNewTable) {
          if (!tdengineStableName.trim()) {
              message.error(t('table_designer.message.tdengine_stable_name_required', undefined, i18nLanguage));
              return;
          }
          if (tdengineChildTagDefs.length > 0) {
              const missing = tdengineChildTagDefs.filter(tag => !(tdengineChildTagValues[tag.name] ?? '').trim());
              if (missing.length > 0) {
                  message.error(t('table_designer.message.tdengine_tag_values_required', undefined, i18nLanguage));
                  return;
              }
          } else if (!tdengineTagValues.trim()) {
              message.error(t('table_designer.message.tdengine_tag_values_required', undefined, i18nLanguage));
              return;
          }
      } else if (columns.length === 0) {
          message.error(t('table_designer.message.add_at_least_one_column', undefined, i18nLanguage));
          return;
      }

      if (isNewTable && isTDengineNewTable && tdengineTableKind === 'stable') {
          if (tdengineTagDefinitions.length === 0) {
              message.error(t('table_designer.message.tdengine_tag_required', undefined, i18nLanguage));
              return;
          }
          if (tdengineTagDefinitions.some(tag => !tag.name.trim() || !tag.type.trim())) {
              message.error(t('table_designer.message.tdengine_tag_invalid', undefined, i18nLanguage));
              return;
          }
      }

      if (isNewTable) {
          // CREATE TABLE
          const sql = buildCreateTableSql(isNewTable ? newTableName : tab.tableName || '', columns, charset, collation);
          setPreviewSql(sql);
          setIsPreviewOpen(true);
      } else {
          const tableInfo = resolveTableInfo();
          if (tableInfo.dbType === 'duckdb') {
              const pkChange = summarizeDuckDbPrimaryKeyChange(originalColumns, columns);
              if (pkChange.isUnsupportedChange) {
                  message.warning(t('table_designer.message.duckdb_primary_key_change_unsupported', undefined, i18nLanguage));
                  return;
              }
          }
          const sql = buildAlterTablePreviewSql({
              dbType: tableInfo.dbType,
              tableName: tableInfo.qualifiedName,
              originalColumns,
              columns,
              translate: (key, params) => t(key, params, i18nLanguage),
          });

          if (!sql.trim()) {
              message.info(t('table_designer.message.no_changes_detected', undefined, i18nLanguage));
              return;
          }
          setPreviewSql(sql);
          setIsPreviewOpen(true);
      }
  };

  const handleRefreshDesigner = () => {
      if (!hasUnsavedDraftChanges) {
          void fetchData();
          return;
      }

      Modal.confirm({
          title: t('table_designer.modal.unsaved_changes_title', undefined, i18nLanguage),
          icon: <ExclamationCircleOutlined />,
          content: t('table_designer.modal.unsaved_changes_content', undefined, i18nLanguage),
          okText: t('table_designer.action.refresh_anyway', undefined, i18nLanguage),
          cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
          onOk: async () => {
              await fetchData();
          },
      });
  };

  const handleExecuteSave = async () => {
      const result = await executeSchemaStatements(previewSql);
      if (!result.ok) {
          if (result.cancelled) return;
          message.error(result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage));
          if (result.schemaMayHaveChanged && !isNewTable) {
              await fetchData();
          }
          return;
      }
      setIsPreviewOpen(false);
      if (!isNewTable) {
              await fetchData();
          } else {
              const connectionId = String(tab.connectionId || '').trim();
              const dbName = String(tab.dbName || '').trim();
              if (connectionId && dbName) {
                  window.dispatchEvent(new CustomEvent('gonavi:sidebar-table-created', {
                      detail: {
                          connectionId,
                          dbName,
                          tableName: qualifyTableDesignerCreateName(
                              String(newTableName || '').trim(),
                              selectedSchema,
                              getDbType(),
                          ),
                          schemaName: supportsTableDesignerSchemaSelection ? designerSchemaTitle : undefined,
                      },
                  }));
              }
          }
      message.success(isNewTable
              ? t('table_designer.message.schema_saved_create', undefined, i18nLanguage)
              : t('table_designer.message.schema_saved_alter', undefined, i18nLanguage));
  };

  // Merge columns with resize handler
  const resizableColumns = useMemo(() => tableColumns.map((col, index) => ({
    ...col,
    onHeaderCell: (column: any) => ({
      width: column.width,
      onResizeStart: handleResizeStart(index),
    }),
  })), [tableColumns]);

  // 字段表 Checkbox 选择列（不参与 resize，支持全选）
  const allColumnKeys = useMemo(() => columns.map(c => c._key), [columns]);
  const isAllColumnsSelected = allColumnKeys.length > 0 && selectedColumnRowKeys.length === allColumnKeys.length;
  const isColumnsIndeterminate = selectedColumnRowKeys.length > 0 && selectedColumnRowKeys.length < allColumnKeys.length;

  const columnSelectCol = useMemo(() => ({
      title: () => (
          <div className="table-designer-select-check">
              <Checkbox
                  checked={isAllColumnsSelected}
                  indeterminate={isColumnsIndeterminate}
                  onChange={(e: any) => setSelectedColumnRowKeys(e.target.checked ? allColumnKeys : [])}
                  style={{ margin: 0 }}
              />
          </div>
      ),
      dataIndex: '_select',
      key: '_select',
      width: 44,
      className: 'table-designer-select-column',
      onHeaderCell: () => ({ className: 'table-designer-select-column' }),
      onCell: () => ({ className: 'table-designer-select-column' }),
      render: (_: any, record: any) => (
          <div className="table-designer-select-check">
              <Checkbox
                  checked={selectedColumnRowKeys.includes(record._key)}
                  onChange={(e: any) => {
                      e.stopPropagation();
                      setSelectedColumnRowKeys((prev: string[]) =>
                          e.target.checked
                              ? [...prev, record._key]
                              : prev.filter((k: string) => k !== record._key)
                      );
                  }}
                  style={{ margin: 0 }}
              />
          </div>
      ),
  }), [selectedColumnRowKeys, allColumnKeys, isAllColumnsSelected, isColumnsIndeterminate]);

  // sort 拖拽列（不参与 resize）
  const sortColumn = useMemo(() => ({
      key: 'sort',
      width: 40,
      render: () => <MenuOutlined style={{ cursor: 'grab', color: '#999' }} />,
  }), []);

  const columnsWithSelect = useMemo(() =>
      readOnly
          ? resizableColumns
          : [columnSelectCol, sortColumn, ...resizableColumns],
      [readOnly, columnSelectCol, sortColumn, resizableColumns]
  );

  // --- Index Columns Init ---
  useEffect(() => {
      setIndexColumns([
          {
              title: t('table_designer.index.column.name', undefined, i18nLanguage),
              dataIndex: 'name',
              key: 'name',
              width: 240,
              render: (text: string) => (
                  <Tooltip title={text}>
                      <span style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {text}
                      </span>
                  </Tooltip>
              ),
          },
          {
              title: t('table_designer.index.column.fields', undefined, i18nLanguage),
              dataIndex: 'columnNames',
              key: 'columnNames',
              width: 320,
              render: (columnNames: string[]) => {
                  if (!columnNames || columnNames.length === 0) {
                      return '-';
                  }
                  return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {columnNames.map((columnName: string, idx: number) => (
                              <Tag key={`${columnName}-${idx}`}>
                                  {columnName}
                              </Tag>
                          ))}
                      </div>
                  );
              }
          },
          {
              title: t('table_designer.index.column.type', undefined, i18nLanguage),
              dataIndex: 'indexType',
              key: 'indexType',
              width: 140,
              render: (text: string) => text || '-',
          },
          {
              title: t('table_designer.index.column.uniqueness', undefined, i18nLanguage),
              dataIndex: 'nonUnique',
              key: 'nonUnique',
              width: 110,
              render: (v: number) => (
                  <Tag color={v === 0 ? 'gold' : 'default'}>
                      {v === 0 ? t('table_designer.index.uniqueness.unique', undefined, i18nLanguage) : t('table_designer.index.uniqueness.normal', undefined, i18nLanguage)}
                  </Tag>
              ),
          },
      ]);
  }, [i18nLanguage]);

  // Checkbox 选择列（不参与 resize，支持全选）
  const allIndexKeys = groupedIndexes.map(idx => idx.key);
  const isAllSelected = allIndexKeys.length > 0 && selectedIndexKeys.length === allIndexKeys.length;
  const isIndeterminate = selectedIndexKeys.length > 0 && selectedIndexKeys.length < allIndexKeys.length;
  const toggleIndexSelection = (key: string, checked?: boolean) => {
      setSelectedIndexKeys(prev => getNextIndexSelection(prev, key, checked));
  };

  const selectColumn = {
      title: () => (
          <Checkbox
              checked={isAllSelected}
              indeterminate={isIndeterminate}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                  setSelectedIndexKeys(e.target.checked ? allIndexKeys : []);
              }}
              style={{ margin: 0 }}
          />
      ),
      dataIndex: '_select',
      key: '_select',
      width: 48,
      className: 'table-designer-select-column',
      onHeaderCell: () => ({ className: 'table-designer-select-column' }),
      onCell: () => ({ className: 'table-designer-select-column' }),
      render: (_: any, record: any) => (
          <span
              onClick={(e) => {
                  e.stopPropagation();
                  toggleIndexSelection(record.key);
              }}
              style={{ display: 'inline-flex' }}
          >
              <Checkbox
                  checked={selectedIndexKeys.includes(record.key)}
                  onChange={() => undefined}
                  style={{ margin: 0, pointerEvents: 'none' }}
              />
          </span>
      ),
  };

  const resizableIndexColumns = [
      selectColumn,
      ...indexColumns.map((col, index) => ({
        ...col,
        onHeaderCell: (column: any) => ({
          width: column.width,
          onResizeStart: handleIndexResizeStart(index),
        }),
      })),
  ];

  const starRocksAdvancedTabContent = (
      <div style={{ height: '100%', overflow: 'auto', padding: 12 }}>
          <Space direction="vertical" size={14} style={{ width: '100%', maxWidth: 960 }}>
              <Radio.Group
                  value={starRocksTableKind}
                  onChange={(e) => setStarRocksTableKind(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  options={[
                      { label: t('table_designer.starrocks.table_kind.olap', undefined, i18nLanguage), value: 'olap' },
                      { label: t('table_designer.starrocks.table_kind.external', undefined, i18nLanguage), value: 'external' },
                  ]}
              />

              {starRocksTableKind === 'olap' ? (
                  <>
                      <Space wrap>
                          <Select
                              value={starRocksKeyModel}
                              onChange={setStarRocksKeyModel}
                              options={[
                                  { label: t('table_designer.starrocks.key_model.duplicate', undefined, i18nLanguage), value: 'DUPLICATE' },
                                  { label: t('table_designer.column.primary_key', undefined, i18nLanguage), value: 'PRIMARY' },
                                  { label: t('table_designer.starrocks.key_model.unique', undefined, i18nLanguage), value: 'UNIQUE' },
                                  { label: t('table_designer.starrocks.key_model.aggregate', undefined, i18nLanguage), value: 'AGGREGATE' },
                              ]}
                              style={{ width: 180 }}
                          />
                          <Select
                              mode="multiple"
                              allowClear
                              placeholder={t('table_designer.starrocks.placeholder.key_columns', undefined, i18nLanguage)}
                              value={starRocksKeyColumns}
                              onChange={setStarRocksKeyColumns}
                              options={localColumnOptions}
                              style={{ minWidth: 280 }}
                          />
                      </Space>

                      <Input.TextArea
                          value={starRocksPartitionClause}
                          onChange={(e) => setStarRocksPartitionClause(e.target.value)}
                          autoSize={{ minRows: 3, maxRows: 8 }}
                          placeholder={t('table_designer.starrocks.placeholder.partition_clause', undefined, i18nLanguage)}
                      />

                      <Space wrap>
                          <Select
                              value={starRocksDistributionType}
                              onChange={setStarRocksDistributionType}
                              options={[
                                  { label: t('table_designer.starrocks.distribution.hash', undefined, i18nLanguage), value: 'HASH' },
                                  { label: t('table_designer.starrocks.distribution.random', undefined, i18nLanguage), value: 'RANDOM' },
                                  { label: t('table_designer.starrocks.distribution.none', undefined, i18nLanguage), value: 'NONE' },
                              ]}
                              style={{ width: 180 }}
                          />
                          <Select
                              mode="multiple"
                              allowClear
                              disabled={starRocksDistributionType !== 'HASH'}
                              placeholder={t('table_designer.starrocks.placeholder.distribution_columns', undefined, i18nLanguage)}
                              value={starRocksDistributionColumns}
                              onChange={setStarRocksDistributionColumns}
                              options={localColumnOptions}
                              style={{ minWidth: 260 }}
                          />
                          <Select
                              value={starRocksBucketMode}
                              onChange={setStarRocksBucketMode}
                              options={[
                                  { label: t('table_designer.starrocks.bucket_mode.auto', undefined, i18nLanguage), value: 'AUTO' },
                                  { label: t('table_designer.starrocks.bucket_mode.number', undefined, i18nLanguage), value: 'NUMBER' },
                              ]}
                              style={{ width: 160 }}
                          />
                          <Input
                              {...noAutoCapInputProps}
                              disabled={starRocksBucketMode !== 'NUMBER'}
                              value={starRocksBucketCount}
                              onChange={(e) => setStarRocksBucketCount(e.target.value.replace(/[^\d]/g, ''))}
                              placeholder={t('table_designer.starrocks.placeholder.bucket_count', undefined, i18nLanguage)}
                              style={{ width: 120 }}
                          />
                      </Space>

                      <Input.TextArea
                          value={starRocksProperties}
                          onChange={(e) => setStarRocksProperties(e.target.value)}
                          autoSize={{ minRows: 3, maxRows: 8 }}
                          placeholder={'"replication_num" = "1"\n"storage_medium" = "SSD"'}
                      />

                      <Input.TextArea
                          value={starRocksRollups}
                          onChange={(e) => setStarRocksRollups(e.target.value)}
                          autoSize={{ minRows: 3, maxRows: 8 }}
                          placeholder={'rollup_name: column1, column2\nrollup_daily: dt, user_id'}
                      />
                  </>
              ) : (
                  <>
                      <Space wrap>
                          <Select
                              value={starRocksExternalEngine}
                              onChange={setStarRocksExternalEngine}
                              options={[
                                  { label: 'Hive', value: 'hive' },
                                  { label: 'MySQL', value: 'mysql' },
                                  { label: 'Iceberg', value: 'iceberg' },
                                  { label: 'Hudi', value: 'hudi' },
                                  { label: 'JDBC', value: 'jdbc' },
                              ]}
                              style={{ width: 180 }}
                          />
                      </Space>
                      <Input.TextArea
                          value={starRocksExternalProperties}
                          onChange={(e) => setStarRocksExternalProperties(e.target.value)}
                          autoSize={{ minRows: 6, maxRows: 14 }}
                          placeholder={'"resource" = "hive0"\n"database" = "raw_db"\n"table" = "raw_table"'}
                      />
                  </>
              )}
          </Space>
      </div>
  );

  const tdengineAdvancedFormContent = (
          <Space direction="vertical" size={14} style={{ width: '100%', maxWidth: 960 }}>
              <Radio.Group
                  value={tdengineTableKind}
                  onChange={(event) => setTdengineTableKind(event.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  options={[
                      { label: t('table_designer.tdengine.table_kind.normal', undefined, i18nLanguage), value: 'normal' },
                      { label: t('table_designer.tdengine.table_kind.stable', undefined, i18nLanguage), value: 'stable' },
                      { label: t('table_designer.tdengine.table_kind.child', undefined, i18nLanguage), value: 'child' },
                  ]}
              />

              {tdengineTableKind === 'stable' && (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Space size={8} style={{ width: '100%' }}>
                          <span style={{ width: 180, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.name', undefined, i18nLanguage)}</span>
                          <span style={{ width: 220, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.type', undefined, i18nLanguage)}</span>
                      </Space>
                      {tdengineTagDefinitions.map((tag) => (
                          <Space key={tag._key} align="start" wrap>
                              <Input
                                  {...noAutoCapInputProps}
                                  value={tag.name}
                                  onChange={(event) => setTdengineTagDefinitions(previous => previous.map(item => item._key === tag._key ? { ...item, name: event.target.value } : item))}
                                  placeholder={t('table_designer.tdengine.placeholder.tag_name', undefined, i18nLanguage)}
                                  style={{ width: 180 }}
                              />
                              <AutoComplete
                                  value={tag.type}
                                  onChange={(value) => setTdengineTagDefinitions(previous => previous.map(item => item._key === tag._key ? { ...item, type: value } : item))}
                                  options={tdengineTagTypeOptions}
                                  placeholder={t('table_designer.tdengine.placeholder.tag_type', undefined, i18nLanguage)}
                                  style={{ width: 220 }}
                              />
                              <Tooltip title={t('table_designer.tdengine.action.remove_tag', undefined, i18nLanguage)}>
                                  <Button
                                      type="text"
                                      danger
                                      icon={<DeleteOutlined />}
                                      onClick={() => setTdengineTagDefinitions(previous => previous.filter(item => item._key !== tag._key))}
                                  />
                              </Tooltip>
                          </Space>
                      ))}
                      <Button
                          size="small"
                          icon={<PlusOutlined />}
                          onClick={() => setTdengineTagDefinitions(previous => [
                              ...previous,
                              { _key: `tag-${Date.now()}-${previous.length}`, name: '', type: 'BINARY(64)' },
                          ])}
                      >
                          {t('table_designer.tdengine.action.add_tag', undefined, i18nLanguage)}
                      </Button>
                  </Space>
              )}

              {tdengineTableKind === 'child' && (
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                      <AutoComplete
                          {...noAutoCapInputProps}
                          allowClear
                          value={tdengineStableName}
                          onChange={(value) => setTdengineStableName(value)}
                          placeholder={t('table_designer.tdengine.placeholder.stable_name', undefined, i18nLanguage)}
                          options={tdengineStableOptions}
                          style={{ width: '100%' }}
                          filterOption={(inputValue, option) =>
                              (option?.value ?? '').toLowerCase().includes(inputValue.toLowerCase())
                          }
                          notFoundContent={tdengineStableOptionsLoading ? t('table_designer.tdengine.message.loading_tag_defs', undefined, i18nLanguage) : t('table_designer.tdengine.message.no_stable_found', undefined, i18nLanguage)}
                      />
                      {tdengineChildTagDefsLoading || tdengineChildTagDefs.length > 0 ? (
                          <Spin spinning={tdengineChildTagDefsLoading}>
                              {tdengineChildTagDefs.length > 0 ? (
                                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                      <Space size={8} style={{ width: '100%' }}>
                                          <span style={{ width: 160, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.name', undefined, i18nLanguage)}</span>
                                          <span style={{ width: 160, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.type', undefined, i18nLanguage)}</span>
                                          <span style={{ color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.value', undefined, i18nLanguage)}</span>
                                      </Space>
                                      {tdengineChildTagDefs.map((tag) => (
                                          <Space key={tag._key} align="start" wrap>
                                              <span style={{ width: 160, lineHeight: '32px', fontSize: 13, fontWeight: 500 }}>{tag.name}</span>
                                              <span style={{ width: 160, lineHeight: '32px', fontSize: 12, color: '#888' }}>{tag.type}</span>
                                              <Input
                                                  {...noAutoCapInputProps}
                                                  value={tdengineChildTagValues[tag.name] ?? ''}
                                                  onChange={(event) => setTdengineChildTagValues(prev => ({ ...prev, [tag.name]: event.target.value }))}
                                                  placeholder={t('table_designer.tdengine.placeholder.tag_value_input', undefined, i18nLanguage)}
                                                  style={{ width: 280 }}
                                              />
                                          </Space>
                                      ))}
                                  </Space>
                              ) : (
                                  <div style={{ padding: '16px 0', textAlign: 'center', color: '#888' }}>
                                      {t('table_designer.tdengine.message.loading_tag_defs', undefined, i18nLanguage)}
                                  </div>
                              )}
                          </Spin>
                      ) : (
                          <Input.TextArea
                              {...noAutoCapInputProps}
                              value={tdengineTagValues}
                              onChange={(event) => setTdengineTagValues(event.target.value)}
                              autoSize={{ minRows: 3, maxRows: 8 }}
                              placeholder={t('table_designer.tdengine.placeholder.tag_values', undefined, i18nLanguage)}
                          />
                      )}
                  </Space>
              )}
          </Space>
  );

  const columnsTabContent = (
      <div
          ref={containerRef}
          className={`table-designer-wrapper${isV2Ui ? ' gn-v2-designer-table-shell' : ''}`}
          onCopy={handleColumnClipboardCopy}
          onPaste={handleColumnClipboardPaste}
          style={{
              height: '100%',
              overflow: 'hidden',
              position: 'relative',
              background: panelBodyBg
          }}
      >
        <style>{`
           .table-designer-wrapper .ant-table-body {
               max-height: ${tableHeight}px !important;
            }
            .table-designer-wrapper .table-designer-focus-row > .ant-table-cell {
                background: ${focusRowBg} !important;
            }
        `}</style>
        {readOnly ? (
        <Table 
            dataSource={columns} 
            columns={columnsWithSelect} 
            rowKey="_key" 
            rowClassName={(record: EditableColumn) => record._key === focusColumnKey ? 'table-designer-focus-row' : ''}
            size="small" 
            pagination={false} 
            loading={columnsLoading}
            scroll={{ y: tableHeight }}
            bordered={false}
            components={{
              header: {
                cell: ResizableTitle,
              },
            }}
        />
  ) : (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={columns.map(c => c._key)} strategy={verticalListSortingStrategy}>
            <Table 
                dataSource={columns} 
                columns={columnsWithSelect} 
                rowKey="_key" 
                rowClassName={(record: EditableColumn) => record._key === focusColumnKey ? 'table-designer-focus-row' : ''}
                size="small" 
                pagination={false} 
                loading={columnsLoading}
                scroll={{ y: tableHeight }}
                bordered={false}
                components={{
                    body: { row: SortableRow },
                    header: { cell: ResizableTitle }
                }}
            />
        </SortableContext>
      </DndContext>
  )}
  </div>
  );

  const tdengineCombinedTabContent = (
      <div
          className="gn-v2-tdengine-combined"
          style={{
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              minHeight: 0,
              overflow: 'hidden',
              background: panelBodyBg,
          }}
      >
          <div
              className="gn-v2-tdengine-options"
              style={{
                  flex: isTDengineChildNewTable ? '1 1 auto' : '0 0 auto',
                  minHeight: 0,
                  maxHeight: isTDengineChildNewTable ? undefined : 'min(42%, 320px)',
                  overflow: 'auto',
                  padding: '10px 12px',
                  borderBottom: isTDengineChildNewTable ? undefined : `1px solid ${panelToolbarBorder}`,
              }}
          >
              {tdengineAdvancedFormContent}
          </div>
          {!isTDengineChildNewTable && (
              <div
                  className="gn-v2-tdengine-columns-section"
                  style={{
                      display: 'flex',
                      flexDirection: 'column',
                      flex: '1 1 auto',
                      minHeight: 0,
                      overflow: 'hidden',
                  }}
              >
                  <div
                      className="gn-v2-tdengine-columns-heading"
                      style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          gap: 8,
                          flex: '0 0 auto',
                          padding: '8px 12px 6px',
                      }}
                  >
                      <strong>{t('table_designer.tab.columns', undefined, i18nLanguage)}</strong>
                      <span style={{ color: darkMode ? 'rgba(255,255,255,0.52)' : 'rgba(0,0,0,0.45)', fontSize: 12 }}>
                          {designerColumnSummary}
                      </span>
                  </div>
                  <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
                      {columnsTabContent}
                  </div>
              </div>
          )}
      </div>
  );

  return (
    <div
        ref={shellRef}
        className={`table-designer-shell${isV2Ui ? ' gn-v2-table-designer' : ''}${embedded ? ' is-embedded' : ''}`}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: embedded ? 0 : '6px 0', position: 'relative' }}
    >
        <style>{`
            .table-designer-shell .ant-table,
            .table-designer-shell .ant-table-wrapper,
            .table-designer-shell .ant-table-container {
                background: transparent !important;
            }
            .table-designer-shell .ant-table-wrapper {
                border: none !important;
                overflow: hidden !important;
            }
            .table-designer-shell .ant-table-container {
                border: none !important;
            }
            .table-designer-shell .ant-table-thead > tr > th {
                background: transparent !important;
                border-bottom: 1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'} !important;
                border-inline-end: 1px solid transparent !important;
            }
            .table-designer-shell .ant-table-tbody > tr > td,
            .table-designer-shell .ant-table-tbody .ant-table-row > .ant-table-cell {
                background: transparent !important;
                border-bottom: 1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'} !important;
                border-inline-end: 1px solid transparent !important;
            }
            .table-designer-shell .ant-table-tbody td .ant-input {
                padding-left: 0 !important;
                padding-right: 0 !important;
            }
            .table-designer-shell .ant-table-tbody td .ant-select .ant-select-selector {
                padding-left: 0 !important;
            }
            .table-designer-shell .table-designer-cell-field {
                display: flex;
                align-items: center;
                min-height: 34px;
                padding: 0 10px;
                border: 1px solid ${darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'};
                border-radius: 10px;
                background: ${darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.72)'};
                box-sizing: border-box;
            }
            .table-designer-shell .table-designer-cell-field .ant-input,
            .table-designer-shell .table-designer-cell-field .ant-select,
            .table-designer-shell .table-designer-cell-field .ant-select-selector,
            .table-designer-shell .table-designer-cell-field .ant-select-selection-search,
            .table-designer-shell .table-designer-cell-field .ant-select-selection-item {
                background: transparent !important;
            }
            .table-designer-shell .table-designer-cell-field .ant-input,
            .table-designer-shell .table-designer-cell-field .ant-select-selection-item,
            .table-designer-shell .table-designer-cell-field input {
                font-size: 13px;
                line-height: 1.4;
            }
            .table-designer-shell .table-designer-cell-field .ant-select {
                width: 100%;
            }
            .table-designer-shell .table-designer-cell-field .ant-select-selector,
            .table-designer-shell .table-designer-cell-field .ant-input {
                padding: 0 !important;
                box-shadow: none !important;
            }
            .table-designer-shell .table-designer-cell-field.is-compact {
                padding-right: 6px;
            }
            .table-designer-shell .table-designer-cell-check {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                min-height: 34px;
            }
            .table-designer-shell .table-designer-cell-check .ant-checkbox-wrapper {
                margin-inline-end: 0 !important;
            }
            .table-designer-shell .table-designer-cell-check.is-left-aligned {
                justify-content: flex-start;
            }
            .table-designer-shell .table-designer-header-title {
                display: inline-flex;
                align-items: center;
                justify-content: flex-start;
                width: 100%;
                line-height: 1.1;
                white-space: nowrap;
            }
            .table-designer-shell .table-designer-select-check {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                height: 100%;
                min-height: 28px;
            }
            .table-designer-shell .table-designer-select-check .ant-checkbox-wrapper {
                margin-inline-end: 0 !important;
            }
            .table-designer-shell .table-designer-select-column {
                text-align: center !important;
                vertical-align: middle !important;
            }
            .table-designer-shell .table-designer-action-column {
                text-align: left !important;
            }
            .table-designer-shell .table-designer-comment-field {
                gap: 4px;
                padding-right: 4px;
            }
            .table-designer-shell .table-designer-comment-field .ant-input {
                flex: 1;
                min-width: 0;
            }
            .table-designer-shell .table-designer-comment-display {
                flex: 1;
                min-width: 0;
                min-height: 28px;
                display: flex;
                align-items: center;
                font: inherit;
                line-height: 1.4;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                cursor: text;
            }
            .table-designer-shell .table-designer-comment-display.is-empty {
                color: ${darkMode ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)'};
            }
            .table-designer-shell .table-designer-action-cell {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
            }
            .table-designer-shell .table-designer-action-cell .ant-btn {
                width: 28px;
                height: 28px;
                padding: 0;
                border-radius: 8px;
            }
            .table-designer-shell .ant-table-thead > tr > th::before {
                display: none !important;
            }
            .table-designer-shell .ant-table-thead > tr > th {
                cursor: default !important;
                user-select: none !important;
                -webkit-user-select: none !important;
            }
            .table-designer-shell .ant-table-tbody > tr:hover > td,
            .table-designer-shell .ant-table-tbody .ant-table-row:hover > .ant-table-cell {
                background: ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.02)'} !important;
            }
            .table-designer-shell .ant-tabs-nav {
                margin-bottom: 8px !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-nav {
                margin-bottom: 0 !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-nav {
                margin-bottom: 0 !important;
            }
            .table-designer-shell .ant-tabs-nav::before {
                border-bottom-color: ${darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'} !important;
            }
            .table-designer-shell .ant-tabs-ink-bar {
                will-change: transform;
                transition: width 0.15s ease, left 0.15s ease, transform 0.15s ease !important;
            }
            .table-designer-shell .ant-tabs-tab {
                transition: color 0.15s ease !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-nav-wrap,
            .table-designer-shell.gn-v2-table-designer .ant-tabs-nav-list {
                width: auto !important;
                min-height: 34px !important;
                align-items: center !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-tab {
                width: auto !important;
                min-width: 0 !important;
                max-width: none !important;
                min-height: 34px !important;
                margin: 0 !important;
                padding: 0 12px !important;
                border-right: 0 !important;
                border-bottom: 0 !important;
                white-space: nowrap !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-tab-btn {
                width: auto !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-nav-wrap,
            .table-designer-shell.is-embedded .ant-tabs-nav-list {
                width: auto !important;
                min-height: 34px !important;
                align-items: center !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-tab {
                width: auto !important;
                min-width: 0 !important;
                max-width: none !important;
                min-height: 34px !important;
                margin: 0 !important;
                padding: 0 12px !important;
                border-right: 0 !important;
                border-bottom: 0 !important;
                white-space: nowrap !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-tab-btn {
                width: auto !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field {
                min-height: 28px;
                padding-inline: 0;
                border: none !important;
                border-radius: 0;
                background: transparent !important;
                box-shadow: none !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-input,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-input:focus,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-input-focused,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-select-selector,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-select-focused .ant-select-selector {
                border: none !important;
                box-shadow: none !important;
                background: transparent !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-display,
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-field .ant-input,
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-field .ant-input input {
                font-size: 12px !important;
                line-height: 1.4 !important;
                font-family: inherit !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field.is-compact {
                padding-right: 0;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-field {
                padding-right: 0;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-check {
                min-height: 30px;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-select-check {
                min-height: 22px;
            }
            .table-designer-shell.is-embedded .table-designer-select-check {
                min-height: 14px !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-action-cell {
                justify-content: flex-start;
                gap: 4px;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-action-cell .ant-btn {
                width: 26px;
                height: 26px;
                border-radius: 7px;
            }
            .table-designer-shell .ant-tabs-content-holder,
            .table-designer-shell .ant-tabs-content,
            .table-designer-shell .ant-tabs-tabpane {
                height: 100%;
            }
            .table-designer-shell .react-resizable-handle {
                position: absolute !important;
                right: 0 !important;
                top: 0 !important;
                bottom: 0 !important;
                width: 10px !important;
                height: auto !important;
                background-position: top right !important;
                cursor: col-resize !important;
                z-index: 10;
                touch-action: none;
            }

        `}</style>
        <div
          ref={ghostRef}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: '2px',
            background: resizeGuideColor,
            zIndex: 9999,
            display: 'none',
            pointerEvents: 'none',
            willChange: 'transform',
          }}
        />
        {isV2Ui && (
            <div className="gn-v2-designer-header">
                <div className="gn-v2-designer-title">
                    <span>{t('table_designer.title.schema_designer', undefined, i18nLanguage)}</span>
                    <strong>{designerTableTitle}</strong>
                </div>
                <div className="gn-v2-designer-meta">
                    <span><TableOutlined /> {designerDbTitle}</span>
                    {supportsTableDesignerSchemaSelection && designerSchemaTitle && <span><FolderOpenOutlined /> {designerSchemaTitle}</span>}
                    <span>{designerColumnSummary}</span>
                    {readOnly && <span>{t('table_designer.status.read_only', undefined, i18nLanguage)}</span>}
                </div>
            </div>
        )}
        <div
            className={isV2Ui ? 'gn-v2-designer-toolbar' : undefined}
            style={{
                padding: '10px 12px 8px 12px',
                borderBottom: `1px solid ${panelToolbarBorder}`,
                borderTopLeftRadius: embedded ? 0 : panelRadius,
                borderTopRightRadius: embedded ? 0 : panelRadius,
                borderLeft: `1px solid ${panelFrameColor}`,
                borderRight: `1px solid ${panelFrameColor}`,
                borderTop: embedded ? 'none' : `1px solid ${panelFrameColor}`,
                background: panelToolbarBg,
                display: 'flex',
                gap: '8px',
                alignItems: 'center'
            }}
        >
            {supportsTableDesignerSchemaSelection && (
                <Select
                    aria-label={t('data_sync.field.schema', undefined, i18nLanguage)}
                    value={designerSchemaTitle || undefined}
                    placeholder={t('data_sync.field.schema', undefined, i18nLanguage)}
                    loading={schemaLoading}
                    disabled={!schemaReady}
                    showSearch
                    optionFilterProp="label"
                    options={designerSchemaTitle && !schemaOptions.some(option => option.value === designerSchemaTitle)
                        ? [{ label: designerSchemaTitle, value: designerSchemaTitle }, ...schemaOptions]
                        : schemaOptions}
                    onChange={handleSchemaChange}
                    style={{ minWidth: 150 }}
                    popupMatchSelectWidth={false}
                />
            )}
            {isNewTable && (
                <>
                    <Input 
                        {...noAutoCapInputProps}
                        placeholder={t('table_designer.placeholder.table_name', undefined, i18nLanguage)}
                        value={newTableName}
                        onChange={e => {
                            const nextTableName = e.target.value;
                            setNewTableName(nextTableName);
                            const explicitSchema = resolveTableDesignerSchema(nextTableName, selectedSchema, getDbType());
                            if (explicitSchema && explicitSchema !== selectedSchema) {
                                latestSelectedSchemaRef.current = explicitSchema;
                                setSelectedSchema(explicitSchema);
                                setTableDesignerSchema?.(tab.connectionId, explicitSchema);
                            }
                        }}
                        style={{ width: 150 }} 
                    />
                    {!isTDengineNewTable && (
                        <>
                            <Select
                                value={charset}
                                onChange={v => {
                                    setCharset(v);
                                    // Set default collation
                                    const cols = (COLLATIONS as any)[v];
                                    if (cols && cols.length > 0) setCollation(cols[0].value);
                                }}
                                options={charsetOptions}
                                style={{ width: 120 }}
                            />
                            <Select
                                value={collation}
                                onChange={setCollation}
                                options={(collationOptions as any)[charset] || []}
                                style={{ width: 150 }}
                            />
                        </>
                    )}
                </>
            )}
            {!readOnly && <Button size="small" icon={<SaveOutlined />} type="primary" disabled={supportsTableDesignerSchemaSelection && !schemaReady} onClick={generateDDL}>{t('table_designer.action.save', undefined, i18nLanguage)}</Button>}
            {!isNewTable && <Button size="small" icon={<ReloadOutlined />} loading={metadataLoading} onClick={handleRefreshDesigner}>{t('table_designer.action.refresh', undefined, i18nLanguage)}</Button>}
            {!isNewTable && !readOnly && supportsTableCommentOps() && (
                <Button size="small" icon={<EditOutlined />} onClick={openTableCommentModal}>{t('table_designer.action.table_comment', undefined, i18nLanguage)}</Button>
            )}
            {!readOnly && !isTDengineChildNewTable && <Button size="small" icon={<PlusOutlined />} onClick={() => handleAddColumn()}>{t('table_designer.action.add_column', undefined, i18nLanguage)}</Button>}
            {!readOnly && !isTDengineChildNewTable && (
                <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={handleAddColumnAfterSelected}
                    disabled={selectedColumnRowKeys.length === 0}
                >
                    {t('table_designer.action.add_after_selected', undefined, i18nLanguage)}
                </Button>
            )}
            {!readOnly && !isTDengineChildNewTable && (
                <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={openCopySelectedColumnsModal}
                    disabled={selectedColumns.length === 0}
                >
                    {t('table_designer.action.copy_selected_to_new_table', undefined, i18nLanguage)}
                </Button>
            )}
            <div style={{ flex: 1 }} />
        </div>
        <Tabs 
            className={isV2Ui ? 'gn-v2-designer-tabs' : undefined}
            activeKey={activeKey}
            onChange={(key) => React.startTransition(() => setActiveKey(key))}
            style={{
                flex: 1,
                minHeight: 0,
                padding: embedded ? 0 : '0 10px 10px 10px',
                borderBottomLeftRadius: embedded ? 0 : panelRadius,
                borderBottomRightRadius: embedded ? 0 : panelRadius,
                borderLeft: `1px solid ${panelFrameColor}`,
                borderRight: `1px solid ${panelFrameColor}`,
                borderBottom: `1px solid ${panelFrameColor}`,
                background: panelBodyBg
            }}
            items={[
                ...(isTDengineNewTable ? [
                    {
                        key: 'tdengine',
                        label: t('table_designer.tab.tdengine', undefined, i18nLanguage),
                        children: tdengineCombinedTabContent,
                    },
                ] : [
                    {
                        key: 'columns',
                        label: t('table_designer.tab.columns', undefined, i18nLanguage),
                        children: columnsTabContent
                    },
                ]),
                ...(isStarRocksNewTable ? [
                    {
                        key: 'starrocks',
                        label: 'StarRocks',
                        children: starRocksAdvancedTabContent,
                    },
                ] : []),
                ...(!isNewTable ? [
                    {
                        key: 'indexes',
                        label: t('table_designer.tab.indexes', undefined, i18nLanguage),
                        children: (
                            <div className={`index-table-wrap${isV2Ui ? ' gn-v2-designer-tab-content gn-v2-designer-index-table' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {!readOnly && (
                                    <div className={isV2Ui ? 'gn-v2-designer-actionbar' : undefined} style={{ display: 'flex', gap: 8 }}>
                                        <Button size="small" icon={<PlusOutlined />} disabled={!supportsIndexSchemaOps()} onClick={openCreateIndexModal}>{t('table_designer.action.add', undefined, i18nLanguage)}</Button>
                                        <Button size="small" icon={<EditOutlined />} disabled={!supportsIndexSchemaOps() || selectedIndexKeys.length !== 1} onClick={openEditIndexModal}>{t('table_designer.action.edit', undefined, i18nLanguage)}</Button>
                                        <Button size="small" icon={<DeleteOutlined />} danger disabled={!supportsIndexSchemaOps() || selectedIndexKeys.length === 0} onClick={handleDeleteIndex}>{t('table_designer.action.delete', undefined, i18nLanguage)}</Button>
                                        {!supportsIndexSchemaOps() && (
                                            <span style={{ marginLeft: 'auto', color: '#faad14', fontSize: 12, alignSelf: 'center' }}>
                                                {t('table_designer.notice.index_readonly', undefined, i18nLanguage)}
                                            </span>
                                        )}
                                        {supportsIndexSchemaOps() && selectedIndexKeys.length > 0 && (
                                            <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                                {t('table_designer.selection.indexes_selected', { count: selectedIndexKeys.length }, i18nLanguage)}
                                            </span>
                                        )}
                                    </div>
                                )}
                                <div className={isV2Ui ? 'gn-v2-designer-section-note' : undefined} style={{ color: '#888', fontSize: 12 }}>
                                    {t('table_designer.summary.indexes', { count: groupedIndexes.length, fields: groupedIndexFieldCount }, i18nLanguage)}
                                </div>
                                <Table
                                    dataSource={groupedIndexes}
                                    columns={resizableIndexColumns}
                                    rowKey="key"
                                    size="small"
                                    pagination={false}
                                    loading={indexesLoading}
                                    scroll={{ x: 960, y: indexTableHeight }}
                                    components={{
                                        header: { cell: ResizableTitle },
                                    }}
                                    onRow={(record) => ({
                                        onClick: () => {
                                            toggleIndexSelection(record.key);
                                        },
                                        style: { cursor: 'pointer' }
                                    })}
                                />
                                {selectedIndexCreateSql && selectedIndex && (
                                    <div style={{ width: '100%' }}>
                                        <div style={{ color: '#666', fontSize: 12, marginBottom: 6 }}>
                                            {t('table_designer.label.create_statement', { name: selectedIndex.name }, i18nLanguage)}
                                        </div>
                                        <TableDesignerSqlPreview sql={selectedIndexCreateSql} darkMode={darkMode} height="160px" />
                                    </div>
                                )}
                            </div>
                        )
                    },
                    {
                        key: 'foreignKeys',
                        label: t('table_designer.tab.foreign_keys', undefined, i18nLanguage),
                        children: (
                            <div className={isV2Ui ? 'gn-v2-designer-tab-content' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {!readOnly && (
                                    <div className={isV2Ui ? 'gn-v2-designer-actionbar' : undefined} style={{ display: 'flex', gap: 8 }}>
                                        <Button size="small" icon={<PlusOutlined />} disabled={!supportsForeignKeySchemaOps()} onClick={openCreateForeignKeyModal}>{t('table_designer.action.add', undefined, i18nLanguage)}</Button>
                                        <Button size="small" icon={<EditOutlined />} disabled={!supportsForeignKeySchemaOps() || !selectedForeignKey} onClick={openEditForeignKeyModal}>{t('table_designer.action.edit', undefined, i18nLanguage)}</Button>
                                        <Button size="small" icon={<DeleteOutlined />} danger disabled={!supportsForeignKeySchemaOps() || !selectedForeignKey} onClick={handleDeleteForeignKey}>{t('table_designer.action.delete', undefined, i18nLanguage)}</Button>
                                        {!supportsForeignKeySchemaOps() && (
                                            <span style={{ marginLeft: 'auto', color: '#faad14', fontSize: 12, alignSelf: 'center' }}>
                                                {t('table_designer.notice.foreign_key_readonly', undefined, i18nLanguage)}
                                            </span>
                                        )}
                                        {supportsForeignKeySchemaOps() && selectedForeignKey && (
                                            <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                                {t('table_designer.selection.foreign_key_selected', { name: selectedForeignKey.constraintName }, i18nLanguage)}
                                            </span>
                                        )}
                                    </div>
                                )}
                                <Table 
                                    dataSource={groupedForeignKeys} 
                                    columns={[
                                        { title: t('table_designer.foreign_key.column.constraint_name', undefined, i18nLanguage), dataIndex: 'constraintName', key: 'constraintName', width: 220 },
                                        {
                                            title: t('table_designer.foreign_key.column.fields', undefined, i18nLanguage),
                                            dataIndex: 'columnNames',
                                            key: 'columnNames',
                                            render: (vals: string[]) => vals?.length ? vals.join(', ') : '-',
                                        },
                                        { title: t('table_designer.foreign_key.column.ref_table', undefined, i18nLanguage), dataIndex: 'refTableName', key: 'refTableName', width: 220 },
                                        {
                                            title: t('table_designer.foreign_key.column.ref_fields', undefined, i18nLanguage),
                                            dataIndex: 'refColumnNames',
                                            key: 'refColumnNames',
                                            render: (vals: string[]) => vals?.length ? vals.join(', ') : '-',
                                        },
                                    ]}
                                    rowKey="key" 
                                    size="small" 
                                    pagination={false} 
                                    loading={foreignKeysLoading}
                                    scroll={{ x: 980, y: tableHeight }}
                                    rowSelection={{
                                        type: 'radio',
                                        selectedRowKeys: selectedForeignKey ? [selectedForeignKey.key] : [],
                                        onChange: (_, selectedRows) => setSelectedForeignKey((selectedRows[0] as ForeignKeyDisplayRow) || null),
                                    }}
                                    onRow={(record) => ({
                                        onClick: () => {
                                            if (selectedForeignKey?.key === record.key) {
                                                setSelectedForeignKey(null);
                                            } else {
                                                setSelectedForeignKey(record);
                                            }
                                        },
                                        style: { cursor: 'pointer' }
                                    })}
                                />
                            </div>
                        )
                    },
                    {
                        key: 'triggers',
                        label: t('table_designer.tab.triggers', undefined, i18nLanguage),
                        children: (
                            <div className={isV2Ui ? 'gn-v2-designer-tab-content' : undefined}>
                                <div className={isV2Ui ? 'gn-v2-designer-actionbar' : undefined} style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                                    <Button
                                        size="small"
                                        icon={<EyeOutlined />}
                                        disabled={!selectedTrigger}
                                        onClick={() => setIsTriggerModalOpen(true)}
                                    >
                                        {t('table_designer.action.view_statement', undefined, i18nLanguage)}
                                    </Button>
                                    {!readOnly && (
                                        <>
                                            <Button size="small" icon={<PlusOutlined />} onClick={handleCreateTrigger}>{t('table_designer.action.add', undefined, i18nLanguage)}</Button>
                                            <Button size="small" icon={<EditOutlined />} disabled={!selectedTrigger} onClick={handleEditTrigger}>{t('table_designer.action.edit', undefined, i18nLanguage)}</Button>
                                            <Button size="small" icon={<DeleteOutlined />} danger disabled={!selectedTrigger} onClick={handleDeleteTrigger}>{t('table_designer.action.delete', undefined, i18nLanguage)}</Button>
                                        </>
                                    )}
                                    <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                        {selectedTrigger
                                            ? t('table_designer.selection.trigger_selected', { name: selectedTrigger.name }, i18nLanguage)
                                            : t('table_designer.selection.trigger_prompt', undefined, i18nLanguage)}
                                    </span>
                                </div>
                                <Table
                                    dataSource={triggers}
                                    columns={[
                                        { title: t('table_designer.trigger.column.name', undefined, i18nLanguage), dataIndex: 'name', key: 'name' },
                                        { title: t('table_designer.trigger.column.timing', undefined, i18nLanguage), dataIndex: 'timing', key: 'timing', width: 100 },
                                        { title: t('table_designer.trigger.column.event', undefined, i18nLanguage), dataIndex: 'event', key: 'event', width: 100 },
                                    ]}
                                    rowKey="name"
                                    size="small"
                                    pagination={false}
                                    loading={triggersLoading}
                                    scroll={{ y: tableHeight }}
                                    locale={{ emptyText: <Empty description={t('table_designer.empty.triggers', undefined, i18nLanguage)} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                                    rowSelection={{
                                        type: 'radio',
                                        selectedRowKeys: selectedTrigger ? [selectedTrigger.name] : [],
                                        onChange: (_, selectedRows) => setSelectedTrigger(selectedRows[0] || null),
                                        onSelect: (record, selected) => {
                                            // 点击单选按钮时，如果已选中则取消
                                            if (selectedTrigger?.name === record.name) {
                                                setSelectedTrigger(null);
                                            } else {
                                                setSelectedTrigger(record);
                                            }
                                        },
                                    }}
                                    onRow={(record) => ({
                                        onClick: () => {
                                            // 点击已选中的行时取消选择
                                            if (selectedTrigger?.name === record.name) {
                                                setSelectedTrigger(null);
                                            } else {
                                                setSelectedTrigger(record);
                                            }
                                        },
                                        style: { cursor: 'pointer' }
                                    })}
                                />
                            </div>
                        )
                    }
                ] : []),
                ...(!isNewTable ? [{
                        key: 'ddl',
                        label: 'DDL',
                        icon: <FileTextOutlined />,
                        children: (
                        <div className={isV2Ui ? 'gn-v2-designer-ddl-shell' : undefined} style={{ height: '100%', minHeight: 320, border: `1px solid ${panelFrameColor}`, borderRadius: panelRadius, background: panelBodyBg }}>
                            <Editor
                                height="100%"
                                language="sql"
                                theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                                value={ddl}
                                options={{
                                    readOnly: true,
                                    minimap: { enabled: false },
                                    fontSize: 14,
                                    lineNumbers: 'on',
                                    scrollBeyondLastLine: true,
                                    wordWrap: 'on',
                                    automaticLayout: true,
                                    padding: { top: 8, bottom: 24 },
                                }}
                            />
                        </div>
                    )
                }] : [])
            ]}
        />

        <Modal
            title={commentEditorColumnName
                ? t('table_designer.modal.column_options_title_named', { name: commentEditorColumnName }, i18nLanguage)
                : t('table_designer.modal.column_options_title', undefined, i18nLanguage)}
            open={isCommentModalOpen}
            onCancel={closeCommentEditor}
            onOk={handleSaveColumnOptions}
            okText={t('table_designer.action.apply', undefined, i18nLanguage)}
            cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
            width={640}
            destroyOnHidden
        >
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Checkbox
                        checked={columnDefaultEnabled}
                        onChange={(event) => setColumnDefaultEnabled(event.target.checked)}
                    >
                        {t('table_designer.column.enable_default', undefined, i18nLanguage)}
                    </Checkbox>
                    <AutoComplete
                        options={COMMON_DEFAULTS}
                        value={columnDefaultValue}
                        onChange={setColumnDefaultValue}
                        disabled={!columnDefaultEnabled}
                        style={{ width: '100%' }}
                        placeholder={t('table_designer.placeholder.column_default', undefined, i18nLanguage)}
                    />
                </Space>
                {getDbType() === 'mysql' && isMySQLCharacterColumnType(commentEditorColumnType) && (
                    <Space wrap size={12} style={{ width: '100%' }}>
                        <AutoComplete
                            allowClear
                            value={columnCharset}
                            onChange={(value) => {
                                setColumnCharset(value || undefined);
                                const options = value ? (COLLATIONS as any)[value] : undefined;
                                setColumnCollation(options?.[0]?.value);
                            }}
                            options={charsetOptions}
                            placeholder={t('table_designer.column.charset', undefined, i18nLanguage)}
                            style={{ width: 180 }}
                        />
                        <AutoComplete
                            allowClear
                            value={columnCollation}
                            onChange={(value) => setColumnCollation(value || undefined)}
                            options={columnCharset ? (collationOptions as any)[columnCharset] || [] : []}
                            placeholder={t('table_designer.column.collation', undefined, i18nLanguage)}
                            style={{ width: 260 }}
                        />
                    </Space>
                )}
                <Input.TextArea
                    value={commentEditorValue}
                    onChange={(e) => setCommentEditorValue(e.target.value)}
                    autoSize={{ minRows: 5, maxRows: 12 }}
                    placeholder={t('table_designer.placeholder.column_comment', undefined, i18nLanguage)}
                    maxLength={2000}
                />
            </Space>
        </Modal>

        <Modal
            title={t('table_designer.modal.copy_columns_title', undefined, i18nLanguage)}
            open={isCopyColumnsModalOpen}
            onCancel={() => setIsCopyColumnsModalOpen(false)}
            onOk={handleExecuteCopySelectedColumns}
            okText={t('table_designer.action.create_table', undefined, i18nLanguage)}
            cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
            confirmLoading={copyExecuting}
            width={560}
        >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div style={{ color: '#666' }}>
                    {t('table_designer.selection.columns_selected', { count: selectedColumns.length }, i18nLanguage)}
                </div>
                <Input
                    {...noAutoCapInputProps}
                    placeholder={t('table_designer.placeholder.target_table_name', undefined, i18nLanguage)}
                    value={copyTableName}
                    onChange={e => setCopyTableName(e.target.value)}
                    maxLength={128}
                />
                <Space wrap>
                    <Select
                        value={copyCharset}
                        onChange={v => {
                            setCopyCharset(v);
                            const cols = (COLLATIONS as any)[v];
                            if (cols && cols.length > 0) setCopyCollation(cols[0].value);
                        }}
                        options={charsetOptions}
                        style={{ width: 160 }}
                    />
                    <Select
                        value={copyCollation}
                        onChange={setCopyCollation}
                        options={(collationOptions as any)[copyCharset] || []}
                        style={{ width: 220 }}
                    />
                </Space>
            </Space>
        </Modal>

        <Modal
            title={t('table_designer.modal.table_comment_title', undefined, i18nLanguage)}
            open={isTableCommentModalOpen}
            onCancel={() => setIsTableCommentModalOpen(false)}
            onOk={handleSaveTableComment}
            okText={t('table_designer.action.save', undefined, i18nLanguage)}
            cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
            confirmLoading={tableCommentSaving}
            width={640}
        >
            <Input.TextArea
                value={tableCommentDraft}
                onChange={(e) => setTableCommentDraft(e.target.value)}
                autoSize={{ minRows: 5, maxRows: 12 }}
                placeholder={t('table_designer.placeholder.table_comment', undefined, i18nLanguage)}
                maxLength={2048}
            />
            <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                {t('table_designer.table_comment.current', {
                    comment: tableComment || t('table_designer.fallback.empty', undefined, i18nLanguage),
                }, i18nLanguage)}
            </div>
        </Modal>

        <Modal
            title={indexModalMode === 'create'
                ? t('table_designer.modal.index_create_title', undefined, i18nLanguage)
                : t('table_designer.modal.index_edit_title', undefined, i18nLanguage)}
            open={isIndexModalOpen}
            onCancel={() => setIsIndexModalOpen(false)}
            onOk={handleSubmitIndex}
            okText={indexModalMode === 'create' ? t('table_designer.action.create', undefined, i18nLanguage) : t('table_designer.action.save', undefined, i18nLanguage)}
            cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
            confirmLoading={indexSaving}
            width={620}
        >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input
                    {...noAutoCapInputProps}
                    placeholder={indexForm.kind === 'PRIMARY'
                        ? t('table_designer.placeholder.primary_index_name', undefined, i18nLanguage)
                        : t('table_designer.placeholder.index_name', undefined, i18nLanguage)}
                    value={indexForm.name}
                    onChange={(e) => setIndexForm(prev => ({ ...prev, name: e.target.value }))}
                    maxLength={128}
                    disabled={indexForm.kind === 'PRIMARY'}
                />
                <Select
                    mode="multiple"
                    allowClear
                    placeholder={t('table_designer.placeholder.index_columns', undefined, i18nLanguage)}
                    value={indexForm.columnNames}
                    onChange={(vals) => setIndexForm(prev => ({ ...prev, columnNames: vals }))}
                    options={localColumnOptions}
                    style={{ width: '100%' }}
                />
                <Space wrap>
                    <Select
                        value={indexForm.kind}
                        options={getIndexKindOptions()}
                        onChange={(val: IndexKind) => {
                            const fixedType = getFixedIndexType(val);
                            if (fixedType) {
                                // 固定类型（PRIMARY/FULLTEXT/SPATIAL）直接设置对应的索引方法
                                setIndexForm(prev => ({
                                    ...prev,
                                    kind: val,
                                    name: val === 'PRIMARY' ? 'PRIMARY' : (prev.name === 'PRIMARY' ? '' : prev.name),
                                    indexType: fixedType,
                                }));
                            } else {
                                const nextTypeOptions = getIndexTypeOptions(val);
                                const currentType = indexForm.indexType || 'DEFAULT';
                                const isCurrentTypeValid = nextTypeOptions.some(opt => opt.value === currentType);
                                setIndexForm(prev => ({
                                    ...prev,
                                    kind: val,
                                    name: val === 'PRIMARY' ? 'PRIMARY' : (prev.name === 'PRIMARY' ? '' : prev.name),
                                    indexType: isCurrentTypeValid ? currentType : 'DEFAULT',
                                }));
                            }
                        }}
                        style={{ width: 220 }}
                    />
                    <Select
                        value={indexForm.indexType}
                        onChange={(val) => setIndexForm(prev => ({ ...prev, indexType: val }))}
                        options={getIndexTypeOptions(indexForm.kind)}
                        style={{ width: 160 }}
                        disabled={indexForm.kind === 'PRIMARY' || indexForm.kind === 'FULLTEXT' || indexForm.kind === 'SPATIAL'}
                    />
                </Space>
                <div style={{ color: '#888', fontSize: 12 }}>
                    {t('table_designer.notice.index_restore_hint', undefined, i18nLanguage)}
                </div>
                <div style={{ width: '100%' }}>
                    <div style={{ color: '#666', fontSize: 12, marginBottom: 6 }}>{t('table_designer.label.create_statement_plain', undefined, i18nLanguage)}</div>
                    <TableDesignerSqlPreview sql={indexCreatePreviewSql} darkMode={darkMode} height="180px" />
                </div>
            </Space>
        </Modal>

        <Modal
            title={foreignKeyModalMode === 'create'
                ? t('table_designer.modal.foreign_key_create_title', undefined, i18nLanguage)
                : t('table_designer.modal.foreign_key_edit_title', undefined, i18nLanguage)}
            open={isForeignKeyModalOpen}
            onCancel={() => setIsForeignKeyModalOpen(false)}
            onOk={handleSubmitForeignKey}
            okText={foreignKeyModalMode === 'create' ? t('table_designer.action.create', undefined, i18nLanguage) : t('table_designer.action.save', undefined, i18nLanguage)}
            cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
            confirmLoading={foreignKeySaving}
            width={700}
        >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input
                    {...noAutoCapInputProps}
                    placeholder={t('table_designer.placeholder.foreign_key_name', undefined, i18nLanguage)}
                    value={foreignKeyForm.constraintName}
                    onChange={(e) => setForeignKeyForm(prev => ({ ...prev, constraintName: e.target.value }))}
                    maxLength={128}
                />
                <Select
                    mode="multiple"
                    allowClear
                    placeholder={t('table_designer.placeholder.local_columns', undefined, i18nLanguage)}
                    value={foreignKeyForm.columnNames}
                    onChange={(vals) => setForeignKeyForm(prev => ({ ...prev, columnNames: vals }))}
                    options={localColumnOptions}
                    style={{ width: '100%' }}
                />
                <Input
                    {...noAutoCapInputProps}
                    placeholder={t('table_designer.placeholder.ref_table', undefined, i18nLanguage)}
                    value={foreignKeyForm.refTableName}
                    onChange={(e) => setForeignKeyForm(prev => ({ ...prev, refTableName: e.target.value }))}
                    maxLength={256}
                />
                <Select
                    mode="tags"
                    tokenSeparators={[',', ' ']}
                    placeholder={t('table_designer.placeholder.ref_columns', undefined, i18nLanguage)}
                    value={foreignKeyForm.refColumnNames}
                    onChange={(vals) => setForeignKeyForm(prev => ({ ...prev, refColumnNames: vals }))}
                    style={{ width: '100%' }}
                />
                <div style={{ color: '#888', fontSize: 12 }}>
                    {t('table_designer.notice.foreign_key_replace_hint', undefined, i18nLanguage)}
                </div>
            </Space>
        </Modal>

        <Modal
            title={t('table_designer.modal.confirm_sql_title', undefined, i18nLanguage)}
            open={isPreviewOpen}
            onOk={handleExecuteSave}
            onCancel={() => setIsPreviewOpen(false)}
            width={700}
            okText={t('table_designer.action.execute', undefined, i18nLanguage)}
            cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
        >
            <TableDesignerSqlPreview sql={previewSql} darkMode={darkMode} />
            <p style={{ marginTop: 10, color: '#faad14' }}>{t('table_designer.notice.sql_irreversible', undefined, i18nLanguage)}</p>
        </Modal>

        <Modal
            title={selectedTrigger
                ? t('table_designer.modal.trigger_detail_title_named', { name: selectedTrigger.name }, i18nLanguage)
                : t('table_designer.modal.trigger_detail_title', undefined, i18nLanguage)}
            open={isTriggerModalOpen}
            onCancel={() => setIsTriggerModalOpen(false)}
            footer={null}
            width={700}
        >
            {selectedTrigger && (
                <div>
                    <div style={{ marginBottom: 12, display: 'flex', gap: 24 }}>
                        <span><strong>{t('table_designer.trigger.field.timing', undefined, i18nLanguage)}:</strong> {selectedTrigger.timing}</span>
                        <span><strong>{t('table_designer.trigger.field.event', undefined, i18nLanguage)}:</strong> {selectedTrigger.event}</span>
                    </div>
                    <div style={{ border: `1px solid ${panelFrameColor}`, borderRadius: panelRadius, background: panelBodyBg }}>
                        <Editor
                            height="350px"
                            language="sql"
                            theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                            value={selectedTrigger.statement}
                            options={{
                                readOnly: true,
                                minimap: { enabled: false },
                                fontSize: 14,
                                lineNumbers: 'on',
                                scrollBeyondLastLine: false,
                                wordWrap: 'on',
                                automaticLayout: true,
                            }}
                        />
                    </div>
                </div>
            )}
        </Modal>

        <Modal
            title={triggerEditMode === 'create'
                ? t('table_designer.modal.trigger_create_title', undefined, i18nLanguage)
                : t('table_designer.modal.trigger_edit_title', undefined, i18nLanguage)}
            open={isTriggerEditModalOpen}
            onCancel={() => setIsTriggerEditModalOpen(false)}
            width={800}
            okText={triggerEditMode === 'create' ? t('table_designer.action.create', undefined, i18nLanguage) : t('table_designer.action.save', undefined, i18nLanguage)}
            cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
            confirmLoading={triggerExecuting}
            onOk={handleExecuteTriggerSql}
        >
            <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
                {triggerEditMode === 'edit' && selectedTrigger && (
                    <span>{t('table_designer.notice.trigger_replace_hint', undefined, i18nLanguage)}</span>
                )}
            </div>
            <div style={{ border: `1px solid ${panelFrameColor}`, borderRadius: panelRadius, background: panelBodyBg }}>
                <Editor
                    height="350px"
                    language="sql"
                    theme={darkMode ? 'vs-dark' : 'light'}
                    value={triggerEditSql}
                    onChange={(val) => setTriggerEditSql(val || '')}
                    options={{
                        minimap: { enabled: false },
                        fontSize: 14,
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                    }}
                />
            </div>
            <p style={{ marginTop: 10, color: '#faad14' }}>{t('table_designer.notice.sql_statement_irreversible', undefined, i18nLanguage)}</p>
        </Modal>
    </div>
  );
};

export default TableDesigner;
