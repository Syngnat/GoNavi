import React, { useEffect, useRef, useState } from 'react';
import type { OnMount, DiffOnMount } from '@monaco-editor/react';
import { Button, Modal, Popconfirm, Space, Spin, Tag } from 'antd';

import { type I18nParams } from '../i18n';
import Editor from './MonacoEditor';
import NacosHistoryDiff from './nacos/NacosHistoryDiff';
import { formatNacosHistoryTime } from './nacos/nacosHistoryTime';

type HistoryRecord = {
  id: string;
  dataId: string;
  group: string;
  content?: string;
  opType?: string;
  createdTime?: string;
  modifiedTime?: string;
};

type Props = {
  open: boolean;
  loading: boolean;
  history: HistoryRecord | null;
  currentConfig: { dataId: string; group: string } | null;
  language: string;
  loadCurrentContent: (record: HistoryRecord) => Promise<string>;
  readOnly: boolean;
  rollingBack: boolean;
  onClose: () => void;
  onRollback: (record: HistoryRecord) => void;
  tr: (key: string, params?: I18nParams) => string;
};

const NacosHistoryDetailModal: React.FC<Props> = ({
  open, loading, history, currentConfig, language, readOnly, rollingBack,
  onClose, onRollback, tr, loadCurrentContent,
}) => {
  const [comparison, setComparison] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState('');
  const requestRef = useRef(0);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const diffRef = useRef<Parameters<DiffOnMount>[0] | null>(null);
  useEffect(() => {
    requestRef.current += 1;
    setComparison(null); setComparing(false); setCompareError('');
    return () => { requestRef.current += 1; };
  }, [open, history?.id, history?.dataId, history?.group]);
  const compare = async () => {
    if (!history) return;
    const request = ++requestRef.current;
    setComparing(true); setCompareError('');
    try {
      const content = await loadCurrentContent(history);
      if (requestRef.current === request) setComparison(content);
    } catch (error) {
      if (requestRef.current === request) setCompareError(String(error instanceof Error ? error.message : error));
    } finally {
      if (requestRef.current === request) setComparing(false);
    }
  };

  return (
    <Modal
      title={tr('nacos_viewer.action.view_history')}
      open={open}
      onCancel={onClose}
      width={comparison === null ? 720 : 1100}
      destroyOnHidden
      modalRender={(modal) => (
        <div onKeyDownCapture={(event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
          const diff = comparison !== null ? diffRef.current : null;
          const editor = diff
            ? (diff.getOriginalEditor().hasWidgetFocus() ? diff.getOriginalEditor() : diff.getModifiedEditor())
            : editorRef.current;
          if (!editor || loading) return;
          event.preventDefault();
          event.stopPropagation();
          editor.focus();
          editor.trigger('nacos-history', 'actions.find', null);
        }}>{modal}</div>
      )}
      footer={
        <Space>
          <Button onClick={onClose}>{tr('common.cancel')}</Button>
          <Popconfirm
            title={tr('nacos_viewer.message.confirm_rollback', {
              group: currentConfig?.group || '',
              dataId: currentConfig?.dataId || '',
              id: history?.id || '',
            })}
            disabled={readOnly || !history}
            onConfirm={() => history && onRollback(history)}
          >
            <Button type="primary" disabled={readOnly || !history} loading={rollingBack}>
              {tr('nacos_viewer.action.rollback')}
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      {loading ? (
        <div style={{ minHeight: 200, display: 'grid', placeItems: 'center' }}><Spin /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Space wrap>
            <Tag>{history?.id}</Tag>
            <Tag>{history?.opType || '-'}</Tag>
            <Tag>{formatNacosHistoryTime(history?.modifiedTime || history?.createdTime)}</Tag>
            <Button disabled={!history || comparing} loading={comparing} onClick={() => {
              if (comparison !== null) { requestRef.current += 1; setComparison(null); } else { void compare(); }
            }}>{tr(comparison === null ? 'nacos.history.compare_current' : 'nacos.history.view_only')}</Button>
          </Space>
          {compareError ? <div role="alert">{compareError}</div> : null}
          {comparison !== null ? (
            <>
              <NacosHistoryDiff original={history?.content ?? ''} modified={comparison} language={language} tr={tr}
                onMount={(editor) => { diffRef.current = editor; }} />
            </>
          ) : (<Editor
            height={360}
            gonaviTypography="data"
            language={language}
            value={history?.content ?? ''}
            onMount={(editor) => { editorRef.current = editor; }}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />)}
        </div>
      )}
    </Modal>
  );
};

export default NacosHistoryDetailModal;
