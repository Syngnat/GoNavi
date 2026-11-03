import React from 'react';
import { Button, Spin, Alert } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import Editor from './MonacoEditor';
import { resolveQueryEditorMonacoLanguage } from './queryEditor/queryEditorEditorState';
import { TabData } from '../types';
import { JobManagementButton } from './databaseJobs/JobManagementButton';
import { useDefinitionViewerState } from './definitionViewer/hooks/useDefinitionViewerState';
import { useDefinitionViewerLoader } from './definitionViewer/hooks/useDefinitionViewerLoader';
import {
  useDefinitionViewerEditActions,
} from './definitionViewer/hooks/useDefinitionViewerEditActions';

export interface DefinitionViewerProps {
    tab: TabData;
}

const DefinitionViewer: React.FC<DefinitionViewerProps> = ({ tab }) => {
    const {
      loading, setLoading, error, setError, definition, setDefinition, openingObjectEdit,
      setOpeningObjectEdit, isMountedRef, loadedDefinitionKeyRef, editorRef, connections, addTab,
      setActiveContext, darkMode, t, objectIdentityKey, getMetadataDialect, isSphinxConnection,
      getCaseInsensitiveRawValue, buildDuckDBMacroDDL, buildShowViewQueries,
      buildShowRoutineQueries, buildShowEventQueries, buildShowSequenceQueries,
      buildShowPackageQueries, runQueryCandidates, runQueryCandidatesCollectAll, getVersionHint,
      extractViewDefinition,
    } = useDefinitionViewerState({ tab });

    const {
      loadDefinition, objectLabel, objectName, loadingTip, normalizedObjectName,
      displayedDefinition, hasDefinition, editTabTitle, editableDefinitionCopy, editorModelPath,
      currentDefinition, handleEditorMount,
    } = useDefinitionViewerLoader({
      t, buildDuckDBMacroDDL, getCaseInsensitiveRawValue, tab, connections, getMetadataDialect,
      isSphinxConnection, buildShowViewQueries, extractViewDefinition, buildShowEventQueries,
      buildShowSequenceQueries, buildShowPackageQueries, buildShowRoutineQueries,
      runQueryCandidatesCollectAll, runQueryCandidates, getVersionHint, setLoading, setError,
      loadedDefinitionKeyRef, objectIdentityKey, setDefinition, isMountedRef, definition, editorRef,
    });

    const { openObjectEditQuery } = useDefinitionViewerEditActions({
      editorRef, tab, loadedDefinitionKeyRef, objectIdentityKey, setDefinition,
      normalizedObjectName, editableDefinitionCopy, setActiveContext, addTab, editTabTitle,
      openingObjectEdit, setOpeningObjectEdit, currentDefinition, setError, loadDefinition,
      isMountedRef, t,
    });

    // 查看器必须与编辑器共用分词器：左侧查看与右侧编辑同一段 SQL 时，关键字配色才能一致。
    const monacoLanguage = resolveQueryEditorMonacoLanguage(
        connections.find((connection) => connection.id === tab.connectionId),
    );

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <Spin tip={loadingTip} />
            </div>
        );
    }

    if (error && !hasDefinition) {
        return (
            <div style={{ padding: 16 }}>
                <Alert type="error" message={t('definition_viewer.error.load_failed')} description={error} showIcon />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '8px 16px', borderBottom: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <strong>{objectLabel}: </strong>{objectName}
                    {tab.dbName && <span style={{ marginLeft: 16, color: '#888' }}>{t('definition_viewer.field.database')}: {tab.dbName}</span>}
                    {tab.routineType && <span style={{ marginLeft: 16, color: '#888' }}>{t('definition_viewer.field.type')}: {tab.routineType}</span>}
                </div>
                {tab.type === 'event-def' && <JobManagementButton tab={tab} onChanged={loadDefinition} />}
                {tab.type === 'job-def' ? <JobManagementButton tab={tab} onChanged={loadDefinition} /> : tab.type !== 'database-link-def' ? (
                <Button size="small" icon={<EditOutlined />} onClick={openObjectEditQuery} disabled={!normalizedObjectName} loading={openingObjectEdit}>
                    {t('definition_viewer.action.edit_object')}
                </Button>
                ) : null}
            </div>
            {error && hasDefinition && (
                <div style={{ padding: '8px 16px 0' }}>
                    <Alert type="warning" message={t(tab.type === 'job-def' ? 'database_jobs.warning.partial_definition' : 'definition_viewer.warning.refresh_latest_failed')} description={error} showIcon />
                </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
                <Editor
                    path={editorModelPath}
                    height="100%"
                    gonaviTypography="sql"
                    language={monacoLanguage}
                    theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                    value={displayedDefinition}
                    onMount={handleEditorMount}
                    options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        lineNumbers: 'on',
                        lineNumbersMinChars: 4,
                        stickyScroll: { enabled: false },
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                    }}
                />
            </div>
        </div>
    );
};

export default DefinitionViewer;
