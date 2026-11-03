import { Button, Modal, Space } from 'antd';
import {
  CompressOutlined,
  ExportOutlined,
  FormatPainterOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import Editor from '../MonacoEditor';
import type { NacosJsonParserApi } from './hooks/useNacosJsonParser';
import type { NacosViewerStateApi } from './hooks/useNacosViewerState';

export interface NacosJsonParserModalProps {
  parser: NacosJsonParserApi;
  darkMode: boolean;
  tr: NacosViewerStateApi['tr'];
}

export const NacosJsonParserModal = ({ parser, darkMode, tr }: NacosJsonParserModalProps) => {
  const { open, value, readOnly, setValue, close, apply, escape, unescape, format, compact } = parser;

  return (
    <Modal
      title={tr('nacos_viewer.json_parser.title')}
      open={open}
      onCancel={close}
      destroyOnHidden
      width={960}
      maskClosable={false}
      footer={[
        <Button key="cancel" onClick={close}>{tr('common.cancel')}</Button>,
        <Button key="apply" type="primary" disabled={readOnly} onClick={apply}>
          {tr('nacos_viewer.json_parser.apply')}
        </Button>,
      ]}
    >
      <Space wrap style={{ marginBottom: 8 }}>
        <Button size="small" icon={<ExportOutlined />} onClick={escape}>
          {tr('nacos_viewer.json_parser.escape')}
        </Button>
        <Button size="small" icon={<ImportOutlined />} onClick={unescape}>
          {tr('nacos_viewer.json_parser.unescape')}
        </Button>
        <Button size="small" icon={<FormatPainterOutlined />} onClick={format}>
          {tr('nacos_viewer.json_parser.format')}
        </Button>
        <Button size="small" icon={<CompressOutlined />} onClick={compact}>
          {tr('nacos_viewer.json_parser.compact')}
        </Button>
      </Space>
      {open ? (
        <Editor
          height="56vh"
          gonaviTypography="data"
          language="json"
          theme={darkMode ? 'transparent-dark' : 'transparent-light'}
          value={value}
          onChange={(next) => setValue(next ?? '')}
          options={{
            readOnly: false,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      ) : null}
    </Modal>
  );
};
