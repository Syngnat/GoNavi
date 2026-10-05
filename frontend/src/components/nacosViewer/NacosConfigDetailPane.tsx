import { Space, Tag, Button, Popconfirm, Tooltip, Spin, Select, Radio, Input } from 'antd';
import {
  HistoryOutlined,
  SaveOutlined,
  DeleteOutlined,
  CloudSyncOutlined,
  ReloadOutlined,
  CloseOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import { CONFIG_TYPE_OPTIONS, resolveEditorLanguage } from './nacosViewerModel';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import Editor from '../MonacoEditor';
import type { NacosViewerStateApi } from './hooks/useNacosViewerState';
import type { NacosViewerBatchActionsApi } from './hooks/useNacosViewerBatchActions';
import type { NacosViewerConfigActionsApi } from './hooks/useNacosViewerConfigActions';

export interface NacosConfigDetailPaneProps {
  detail: NacosViewerStateApi['detail'];
  workbenchTheme: NacosViewerStateApi['workbenchTheme'];
  betaExists: NacosViewerStateApi['betaExists'];
  tr: NacosViewerStateApi['tr'];
  openHistory: NacosViewerBatchActionsApi['openHistory'];
  publishing: NacosViewerStateApi['publishing'];
  readOnly: NacosViewerStateApi['readOnly'];
  draftDirty: NacosViewerStateApi['draftDirty'];
  handlePublish: NacosViewerConfigActionsApi['handlePublish'];
  publishMode: NacosViewerStateApi['publishMode'];
  handleDelete: NacosViewerBatchActionsApi['handleDelete'];
  remoteChanged: NacosViewerStateApi['remoteChanged'];
  remoteChangedHint: NacosViewerBatchActionsApi['remoteChangedHint'];
  handleReloadRemote: NacosViewerBatchActionsApi['handleReloadRemote'];
  setRemoteChanged: NacosViewerStateApi['setRemoteChanged'];
  loadingDetail: NacosViewerStateApi['loadingDetail'];
  draftType: NacosViewerStateApi['draftType'];
  setDraftType: NacosViewerStateApi['setDraftType'];
  setDraftDirty: NacosViewerStateApi['setDraftDirty'];
  setPublishMode: NacosViewerStateApi['setPublishMode'];
  betaIps: NacosViewerStateApi['betaIps'];
  setBetaIps: NacosViewerStateApi['setBetaIps'];
  handleLoadBetaContent: NacosViewerConfigActionsApi['handleLoadBetaContent'];
  handleStopBeta: NacosViewerConfigActionsApi['handleStopBeta'];
  darkMode: NacosViewerStateApi['darkMode'];
  draftContent: NacosViewerStateApi['draftContent'];
  setDraftContent: NacosViewerStateApi['setDraftContent'];
}

export const NacosConfigDetailPane = ({
  detail, workbenchTheme, betaExists, tr, openHistory, publishing, readOnly, draftDirty,
  handlePublish, publishMode, handleDelete, remoteChanged, remoteChangedHint, handleReloadRemote,
  setRemoteChanged, loadingDetail, draftType, setDraftType, setDraftDirty, setPublishMode, betaIps,
  setBetaIps, handleLoadBetaContent, handleStopBeta, darkMode, draftContent, setDraftContent,
}: NacosConfigDetailPaneProps) => (
  <div
    className={'gn-v2-nacos-detail-pane'}
    style={
      { minHeight: 0, overflow: 'hidden' }
    }
  >
    <div
      className={'gn-v2-nacos-pane-header'}
      style={undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Space wrap size={[8, 8]}>
          {detail ? (
            <>
              <Tag>{detail.group}</Tag>
              <strong style={{ color: workbenchTheme.textPrimary }}>{detail.dataId}</strong>
              {detail.md5 ? <Tag color="default">{detail.md5}</Tag> : null}
              {betaExists ? <Tag color="purple">{tr('nacos_viewer.status.beta_active')}</Tag> : null}
            </>
          ) : (
            <span style={{ color: workbenchTheme.textMuted }}>{tr('nacos_viewer.message.select_config')}</span>
          )}
        </Space>
        <Space wrap size={[8, 8]}>
          <Button
            icon={<HistoryOutlined />}
            disabled={!detail}
            onClick={() => void openHistory()}
          >
            {tr('nacos_viewer.action.history')}
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={publishing}
            disabled={readOnly || !detail || !draftDirty}
            onClick={() => void handlePublish()}
          >
            {publishMode === 'beta'
              ? tr('nacos_viewer.action.publish_beta')
              : tr('nacos_viewer.action.publish')}
          </Button>
          <Popconfirm
            title={tr('nacos_viewer.message.confirm_delete', {
              group: detail?.group || '',
              dataId: detail?.dataId || '',
            })}
            disabled={readOnly || !detail}
            onConfirm={() => void handleDelete()}
          >
            <Button danger icon={<DeleteOutlined />} disabled={readOnly || !detail}>
              {tr('nacos_viewer.action.delete')}
            </Button>
          </Popconfirm>
        </Space>
      </div>
      {remoteChanged ? (
        <div
          className={`gn-v2-nacos-remote-notice${draftDirty ? ' is-dirty' : ''}`}
          role="status"
          aria-live="polite"
        >
          <CloudSyncOutlined className="gn-v2-nacos-remote-notice__icon" />
          <span className="gn-v2-nacos-remote-notice__copy">
            <span
              className="gn-v2-nacos-remote-notice__title"
              title={tr('nacos_viewer.message.remote_changed_banner')}
            >
              {tr('nacos_viewer.message.remote_changed_banner')}
            </span>
            {draftDirty ? (
              <span className="gn-v2-nacos-remote-notice__hint" title={remoteChangedHint}>
                {remoteChangedHint}
              </span>
            ) : null}
          </span>
          <span className="gn-v2-nacos-remote-notice__actions">
            <Button
              className="gn-v2-nacos-remote-notice__reload"
              size="small"
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => void handleReloadRemote()}
            >
              {tr('nacos_viewer.action.reload_remote')}
            </Button>
            <Tooltip title={tr('nacos_viewer.action.dismiss_remote')}>
              <Button
                className="gn-v2-nacos-remote-notice__dismiss"
                size="small"
                type="text"
                icon={<CloseOutlined />}
                aria-label={tr('nacos_viewer.action.dismiss_remote')}
                onClick={() => setRemoteChanged(false)}
              />
            </Tooltip>
          </span>
        </div>
      ) : null}
    </div>

    <div
      className={'gn-v2-nacos-pane-body'}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: undefined,
        overflow: 'hidden',
      }}
    >
      {loadingDetail ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
          <Spin />
        </div>
      ) : !detail ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: workbenchTheme.textMuted }}>
          {tr('nacos_viewer.message.select_config')}
        </div>
      ) : (
        <>
          <Space wrap>
            <Select
              style={{ width: 140 }}
              value={draftType}
              options={CONFIG_TYPE_OPTIONS}
              disabled={readOnly}
              onChange={(value) => {
                setDraftType(value);
                setDraftDirty(true);
              }}
            />
            <Radio.Group
              size="small"
              value={publishMode}
              onChange={(event) => setPublishMode(event.target.value)}
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: tr('nacos_viewer.mode.formal'), value: 'formal' },
                { label: tr('nacos_viewer.mode.beta'), value: 'beta' },
              ]}
            />
          </Space>
          {publishMode === 'beta' ? (
            <Space wrap style={{ width: '100%' }}>
              <Input
                {...noAutoCapInputProps}
                style={{ minWidth: 280, flex: 1 }}
                placeholder={tr('nacos_viewer.field.beta_ips_placeholder')}
                value={betaIps}
                disabled={readOnly}
                onChange={(event) => setBetaIps(event.target.value)}
                prefix={<ExperimentOutlined />}
              />
              <Button size="small" disabled={!betaExists} onClick={() => void handleLoadBetaContent()}>
                {tr('nacos_viewer.action.load_beta')}
              </Button>
              <Popconfirm
                title={tr('nacos_viewer.message.confirm_stop_beta')}
                disabled={readOnly || !betaExists}
                onConfirm={() => void handleStopBeta()}
              >
                <Button size="small" danger disabled={readOnly || !betaExists}>
                  {tr('nacos_viewer.action.stop_beta')}
                </Button>
              </Popconfirm>
            </Space>
          ) : null}
          <div style={{ flex: 1, minHeight: 240, minWidth: 0 }}>
            <Editor
              height="100%"
              gonaviTypography="data"
              language={resolveEditorLanguage(draftType)}
              theme={darkMode ? 'transparent-dark' : 'transparent-light'}
              value={draftContent}
              onChange={(value) => {
                setDraftContent(value ?? '');
                setDraftDirty(true);
              }}
              options={{
                readOnly,
                minimap: { enabled: false },
                lineNumbers: 'on',
                wordWrap: 'on',
                fontSize: 13,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                folding: true,
              }}
            />
          </div>
        </>
      )}
    </div>
  </div>
);
