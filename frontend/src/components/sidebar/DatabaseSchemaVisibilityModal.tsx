import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Space,
  Spin,
  Tag,
  Tree,
  Typography,
  message,
} from 'antd';
import {
  DatabaseOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';

import type { SchemaVisibilityRule } from '../../types';
import { t } from '../../i18n';
import Modal from '../common/ResizableDraggableModal';
import {
  buildDatabaseSchemaVisibilityDraft,
  findSchemaVisibilityRuleEntry,
  formatDatabasePatternText,
  getDatabaseTreeTriState,
  mergeDatabaseVisibilityCandidates,
  mergeSchemaSelectionAfterRefresh,
  mergeSelectionAfterDatabaseRefresh,
  normalizeDatabaseNames,
  parseDatabasePatternText,
  resolveSchemaSelection,
  resolveSelectedDatabaseNames,
  type DatabaseRuleOwnership,
  type DatabaseSchemaVisibilityDraft,
  type DatabaseSchemaVisibilitySource,
  type DatabaseVisibilityCandidate,
  type SchemaSelectionSnapshot,
} from './databaseSchemaVisibility';

const { Text, Title } = Typography;

export type DatabaseSchemaVisibilityLoadResult = {
  supported: boolean;
  schemas: string[];
  failureMessage?: string;
};

export type DatabaseSchemaVisibilityModalProps = {
  open: boolean;
  connectionName: string;
  source: DatabaseSchemaVisibilitySource;
  initialDatabase?: string;
  primaryLabel: string;
  supportsSchemas: boolean;
  databaseCaseSensitive: boolean;
  schemaCaseSensitive: boolean;
  saving?: boolean;
  loadDatabases: () => Promise<string[]>;
  loadSchemas: (database: string) => Promise<DatabaseSchemaVisibilityLoadResult>;
  onCancel: () => void;
  onSave: (draft: DatabaseSchemaVisibilityDraft) => Promise<void> | void;
};

type SchemaSnapshots = Record<string, SchemaSelectionSnapshot>;

const databaseKey = (database: string) => `database:${database}`;
const schemaKey = (database: string, schema: string) => `schema:${database}:${schema}`;
const schemaIdentity = (schema: string, caseSensitive: boolean) => (
  caseSensitive ? schema : schema.toLocaleLowerCase()
);

const candidateTitle = (candidate: DatabaseVisibilityCandidate) => (
  <Space size={6}>
    <span>{candidate.name}</span>
    {candidate.historical && <Tag>{t('sidebar.database_schema_visibility.status.historical')}</Tag>}
  </Space>
);

export const DatabaseSchemaVisibilityModal: React.FC<DatabaseSchemaVisibilityModalProps> = ({
  open,
  connectionName,
  source,
  initialDatabase,
  primaryLabel,
  supportsSchemas,
  databaseCaseSensitive,
  schemaCaseSensitive,
  saving = false,
  loadDatabases,
  loadSchemas,
  onCancel,
  onSave,
}) => {
  const requestGenerationRef = useRef(0);
  const schemaRequestIdsRef = useRef<Record<string, number>>({});
  const [candidates, setCandidates] = useState<DatabaseVisibilityCandidate[]>([]);
  const [selectedDatabases, setSelectedDatabases] = useState<string[]>([]);
  const [schemaSnapshots, setSchemaSnapshots] = useState<SchemaSnapshots>({});
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [ownership, setOwnership] = useState<DatabaseRuleOwnership>('advanced');
  const [exactSelectionChanged, setExactSelectionChanged] = useState(false);
  const [includePatternsText, setIncludePatternsText] = useState('');
  const [excludePatternsText, setExcludePatternsText] = useState('');

  const hasPatterns = useMemo(() => (
    parseDatabasePatternText(includePatternsText).length > 0
    || parseDatabasePatternText(excludePatternsText).length > 0
  ), [excludePatternsText, includePatternsText]);

  const refreshDatabases = useCallback(async (preserveSelection: boolean) => {
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    try {
      const databaseNames = await loadDatabases();
      if (requestGenerationRef.current !== generation) return;
      const nextCandidates = mergeDatabaseVisibilityCandidates(databaseNames, source, initialDatabase);
      setCandidates((previousCandidates) => {
        setSelectedDatabases((previousSelection) => preserveSelection
          ? mergeSelectionAfterDatabaseRefresh(
            previousCandidates,
            nextCandidates,
            previousSelection,
            source,
            exactSelectionChanged,
          )
          : resolveSelectedDatabaseNames(source, nextCandidates.map((candidate) => candidate.name)));
        return nextCandidates;
      });
    } catch (error: any) {
      if (requestGenerationRef.current !== generation) return;
      message.error(t('sidebar.database_schema_visibility.message.load_failed', {
        error: error?.message || String(error),
      }));
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
    }
  }, [exactSelectionChanged, initialDatabase, loadDatabases, source]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    schemaRequestIdsRef.current = {};
    if (!open) return;
    setCandidates([]);
    setSelectedDatabases([]);
    setSchemaSnapshots({});
    setExpandedKeys(initialDatabase ? [databaseKey(initialDatabase)] : []);
    setSearch('');
    setExactSelectionChanged(false);
    const patternsExist = Boolean(
      source.includeDatabasePatterns?.length || source.excludeDatabasePatterns?.length,
    );
    setOwnership(patternsExist ? 'advanced' : 'exact');
    setIncludePatternsText(formatDatabasePatternText(source.includeDatabasePatterns));
    setExcludePatternsText(formatDatabasePatternText(source.excludeDatabasePatterns));
    void refreshDatabases(false);
  }, [initialDatabase, open]);

  const loadDatabaseSchemas = useCallback(async (database: string, force = false) => {
    if (!supportsSchemas) return;
    const current = schemaSnapshots[database];
    if (!force && (current?.status === 'loading' || current?.status === 'loaded')) return;
    const generation = requestGenerationRef.current;
    const requestId = (schemaRequestIdsRef.current[database] || 0) + 1;
    schemaRequestIdsRef.current[database] = requestId;
    const isCurrentRequest = () => (
      requestGenerationRef.current === generation
      && schemaRequestIdsRef.current[database] === requestId
    );
    setSchemaSnapshots((previous) => ({
      ...previous,
      [database]: {
        status: 'loading',
        availableSchemas: previous[database]?.availableSchemas || [],
        selectedSchemas: previous[database]?.selectedSchemas || [],
      },
    }));
    try {
      const result = await loadSchemas(database);
      if (!isCurrentRequest()) return;
      const rule = findSchemaVisibilityRuleEntry(
        source.schemaVisibilityByDatabase || undefined,
        database,
        databaseCaseSensitive,
      )?.[1];
      setSchemaSnapshots((previous) => ({
        ...previous,
        [database]: result.supported
          ? mergeSchemaSelectionAfterRefresh(
            previous[database],
            rule,
            result.schemas,
            schemaCaseSensitive,
          )
          : {
            status: result.failureMessage ? 'error' : 'unsupported',
            availableSchemas: previous[database]?.availableSchemas || [],
            selectedSchemas: previous[database]?.selectedSchemas || [],
          },
      }));
      if (result.failureMessage) {
        message.warning(result.failureMessage);
      }
    } catch (error: any) {
      if (!isCurrentRequest()) return;
      setSchemaSnapshots((previous) => ({
        ...previous,
        [database]: {
          status: 'error',
          availableSchemas: previous[database]?.availableSchemas || [],
          selectedSchemas: previous[database]?.selectedSchemas || [],
        },
      }));
      message.error(t('sidebar.database_schema_visibility.message.schema_load_failed', {
        database,
        error: error?.message || String(error),
      }));
    }
  }, [
    databaseCaseSensitive,
    loadSchemas,
    schemaCaseSensitive,
    schemaSnapshots,
    source.schemaVisibilityByDatabase,
    supportsSchemas,
  ]);

  useEffect(() => {
    if (!open || !initialDatabase || !supportsSchemas) return;
    void loadDatabaseSchemas(initialDatabase);
  }, [initialDatabase, open, supportsSchemas]);

  const toggleDatabase = useCallback((database: string, checked: boolean) => {
    setExactSelectionChanged(true);
    setSelectedDatabases((previous) => {
      const next = new Set(previous);
      if (checked) next.add(database);
      else next.delete(database);
      return candidates.map((candidate) => candidate.name).filter((name) => next.has(name));
    });
    if (checked && supportsSchemas) void loadDatabaseSchemas(database);
  }, [candidates, loadDatabaseSchemas, supportsSchemas]);

  const toggleSchema = useCallback((
    database: string,
    schema: string,
    checked: boolean,
    databaseSelected: boolean,
  ) => {
    if (checked && !databaseSelected) {
      setExactSelectionChanged(true);
      setSelectedDatabases((previous) => {
        const next = new Set(previous);
        next.add(database);
        return candidates.map((candidate) => candidate.name).filter((name) => next.has(name));
      });
    }
    setSchemaSnapshots((previous) => {
      const rule = findSchemaVisibilityRuleEntry(
        source.schemaVisibilityByDatabase || undefined,
        database,
        databaseCaseSensitive,
      )?.[1];
      const current = previous[database] || resolveSchemaSelection(rule, [schema], schemaCaseSensitive);
      const targetIdentity = schemaIdentity(schema, schemaCaseSensitive);
      const nextSchemas = (databaseSelected ? current.selectedSchemas : []).filter(
        (item) => schemaIdentity(item, schemaCaseSensitive) !== targetIdentity,
      );
      if (checked) nextSchemas.push(schema);
      return {
        ...previous,
        [database]: { ...current, selectedSchemas: nextSchemas },
      };
    });
  }, [
    candidates,
    databaseCaseSensitive,
    schemaCaseSensitive,
    source.schemaVisibilityByDatabase,
  ]);

  const filteredCandidates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return candidates;
    return candidates.filter((candidate) => {
      if (candidate.name.toLocaleLowerCase().includes(query)) return true;
      return schemaSnapshots[candidate.name]?.availableSchemas.some(
        (schema) => schema.toLocaleLowerCase().includes(query),
      );
    });
  }, [candidates, schemaSnapshots, search]);

  const treeData = useMemo<DataNode[]>(() => filteredCandidates.map((candidate) => {
    const database = candidate.name;
    const selected = selectedDatabases.includes(database);
    const snapshot = schemaSnapshots[database];
    const existingRule = findSchemaVisibilityRuleEntry(
      source.schemaVisibilityByDatabase || undefined,
      database,
      databaseCaseSensitive,
    )?.[1];
    const triState = getDatabaseTreeTriState({
      databaseSelected: selected,
      supportsSchemas,
      schemaSnapshot: snapshot,
      hasExistingSchemaRule: Boolean(existingRule),
      schemaCaseSensitive,
    });
    const children: DataNode[] = [];
    if (supportsSchemas) {
      if (snapshot?.status === 'loaded') {
        snapshot.availableSchemas.forEach((schema) => {
          children.push({
            key: schemaKey(database, schema),
            isLeaf: true,
            title: (
              <Checkbox
                checked={selected && snapshot.selectedSchemas.some(
                  (item) => schemaIdentity(item, schemaCaseSensitive) === schemaIdentity(schema, schemaCaseSensitive),
                )}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => toggleSchema(
                  database,
                  schema,
                  event.target.checked,
                  selected,
                )}
              >
                {schema}
              </Checkbox>
            ),
          });
        });
      } else if (snapshot?.status === 'loading') {
        children.push({ key: `${databaseKey(database)}:loading`, title: <Spin size="small" />, isLeaf: true });
      } else if (snapshot?.status === 'error') {
        children.push({
          key: `${databaseKey(database)}:error`,
          isLeaf: true,
          title: (
            <Button size="small" type="link" onClick={() => void loadDatabaseSchemas(database, true)}>
              {t('common.retry')}
            </Button>
          ),
        });
      } else {
        children.push({ key: `${databaseKey(database)}:placeholder`, title: '', isLeaf: true });
      }
    }
    return {
      key: databaseKey(database),
      icon: <DatabaseOutlined />,
      isLeaf: !supportsSchemas,
      children: supportsSchemas ? children : undefined,
      title: (
        <Checkbox
          checked={triState === 'all'}
          indeterminate={triState === 'partial'}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => toggleDatabase(database, event.target.checked)}
        >
          {candidateTitle(candidate)}
        </Checkbox>
      ),
    };
  }), [
    filteredCandidates,
    loadDatabaseSchemas,
    databaseCaseSensitive,
    schemaCaseSensitive,
    schemaSnapshots,
    selectedDatabases,
    source.schemaVisibilityByDatabase,
    supportsSchemas,
    toggleDatabase,
    toggleSchema,
  ]);

  const selectAll = () => {
    setExactSelectionChanged(true);
    setSelectedDatabases(candidates.map((candidate) => candidate.name));
  };
  const clearSelection = () => {
    setExactSelectionChanged(true);
    setSelectedDatabases([]);
  };

  const handleSave = async () => {
    const result = buildDatabaseSchemaVisibilityDraft({
      source,
      databaseNames: candidates.map((candidate) => candidate.name),
      selectedDatabases,
      databaseRuleOwnership: ownership,
      advancedExactIncludes: source.includeDatabases || [],
      includeDatabasePatterns: parseDatabasePatternText(includePatternsText),
      excludeDatabasePatterns: parseDatabasePatternText(excludePatternsText),
      exactSelectionChanged,
      schemaSelectionsByDatabase: schemaSnapshots,
      databaseCaseSensitive,
      schemaCaseSensitive,
    });
    const firstError = result.errors[0];
    if (firstError?.code === 'no-database-selected') {
      message.error(t('sidebar.database_schema_visibility.validation.database_required'));
      return;
    }
    if (firstError?.code === 'no-schema-selected') {
      message.error(t('sidebar.database_schema_visibility.validation.schema_required', {
        database: firstError.database || '',
      }));
      return;
    }
    if (firstError?.code === 'exact-conversion-required') {
      message.error(t('sidebar.database_schema_visibility.validation.convert_required'));
      return;
    }
    if (result.draft) await onSave(result.draft);
  };

  return (
    <Modal
      open={open}
      title={t('sidebar.database_schema_visibility.title', { connection: connectionName })}
      width={760}
      centered
      resizable
      minResizableWidth={620}
      okText={t('common.save')}
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={() => void handleSave()}
      destroyOnClose
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Text type="secondary">
          {t('sidebar.database_schema_visibility.description', { primary: primaryLabel })}
        </Text>
        {hasPatterns && ownership === 'advanced' && (
          <Alert
            type="warning"
            showIcon
            message={t('sidebar.database_schema_visibility.pattern.title')}
            description={t('sidebar.database_schema_visibility.pattern.description')}
            action={(
              <Button size="small" onClick={() => setOwnership('exact')}>
                {t('sidebar.database_schema_visibility.pattern.convert')}
              </Button>
            )}
          />
        )}
        <div className="gn-schema-visibility-search">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            value={search}
            placeholder={t('sidebar.database_schema_visibility.search')}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refreshDatabases(true)}>
            {t('common.refresh')}
          </Button>
        </div>
        <Space wrap>
          <Button size="small" onClick={selectAll}>
            {t('sidebar.database_schema_visibility.action.select_all')}
          </Button>
          <Button size="small" onClick={clearSelection}>
            {t('sidebar.database_schema_visibility.action.clear')}
          </Button>
          <Text type="secondary">
            {t('sidebar.database_schema_visibility.selected_count', {
              selected: selectedDatabases.length,
              total: candidates.length,
            })}
          </Text>
        </Space>
        <div style={{ minHeight: 300, maxHeight: 430, overflow: 'auto', border: '1px solid var(--ant-color-border-secondary)', borderRadius: 8, padding: 10 }}>
          {loading && candidates.length === 0 ? (
            <div style={{ display: 'grid', placeItems: 'center', minHeight: 260 }}><Spin /></div>
          ) : treeData.length > 0 ? (
            <Tree
              showIcon
              blockNode
              selectable={false}
              treeData={treeData}
              expandedKeys={expandedKeys}
              onExpand={(keys, info) => {
                setExpandedKeys(keys);
                const rawKey = String(info.node.key);
                if (info.expanded && rawKey.startsWith('database:')) {
                  void loadDatabaseSchemas(rawKey.slice('database:'.length));
                }
              }}
            />
          ) : <Empty description={t('sidebar.database_schema_visibility.empty')} />}
        </div>
        {ownership === 'advanced' && (
          <div style={{ padding: 12, borderRadius: 8, background: 'var(--ant-color-fill-quaternary)' }}>
            <Title level={5} style={{ marginTop: 0 }}>{t('sidebar.database_schema_visibility.pattern.advanced')}</Title>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input.TextArea
                rows={2}
                value={includePatternsText}
                placeholder={t('sidebar.database_schema_visibility.pattern.include')}
                onChange={(event) => setIncludePatternsText(event.target.value)}
              />
              <Input.TextArea
                rows={2}
                value={excludePatternsText}
                placeholder={t('sidebar.database_schema_visibility.pattern.exclude')}
                onChange={(event) => setExcludePatternsText(event.target.value)}
              />
            </Space>
          </div>
        )}
      </Space>
    </Modal>
  );
};

export default DatabaseSchemaVisibilityModal;
