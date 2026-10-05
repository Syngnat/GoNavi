import { Modal, Form, Input, InputNumber, Space, Switch } from 'antd';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import type { NacosServiceViewerStateApi } from './hooks/useNacosServiceViewerState';
import type {
  NacosServiceViewerInstanceActionsApi,
} from './hooks/useNacosServiceViewerInstanceActions';

export interface NacosInstanceModalProps {
  editingInstance: NacosServiceViewerStateApi['editingInstance'];
  tr: NacosServiceViewerStateApi['tr'];
  instanceModalOpen: NacosServiceViewerStateApi['instanceModalOpen'];
  savingInstance: NacosServiceViewerStateApi['savingInstance'];
  closeInstanceModal: NacosServiceViewerStateApi['closeInstanceModal'];
  handleSaveInstance: NacosServiceViewerInstanceActionsApi['handleSaveInstance'];
  instanceForm: NacosServiceViewerStateApi['instanceForm'];
  canUpdateInstanceHealth: NacosServiceViewerInstanceActionsApi['canUpdateInstanceHealth'];
}

export const NacosInstanceModal = ({
  editingInstance, tr, instanceModalOpen, savingInstance, closeInstanceModal, handleSaveInstance,
  instanceForm, canUpdateInstanceHealth,
}: NacosInstanceModalProps) => (
  <Modal
    title={
      editingInstance
        ? tr('nacos_service.action.edit_instance')
        : tr('nacos_service.action.register_instance')
    }
    open={instanceModalOpen}
    confirmLoading={savingInstance}
    onCancel={closeInstanceModal}
    onOk={() => void handleSaveInstance()}
    destroyOnHidden
  >
    <Form form={instanceForm} layout="vertical">
      <Form.Item name="serviceName" label={tr('nacos_service.field.service')}>
        <Input disabled {...noAutoCapInputProps} />
      </Form.Item>
      <Form.Item name="groupName" label={tr('nacos_service.field.group')}>
        <Input disabled {...noAutoCapInputProps} />
      </Form.Item>
      <Form.Item name="ip" label="IP" rules={[{ required: true }]}>
        <Input disabled={!!editingInstance} {...noAutoCapInputProps} />
      </Form.Item>
      <Form.Item name="port" label="Port" rules={[{ required: true }]}>
        <InputNumber min={1} max={65535} style={{ width: '100%' }} disabled={!!editingInstance} />
      </Form.Item>
      <Form.Item name="clusterName" label={tr('nacos_service.field.cluster')}>
        <Input disabled={!!editingInstance} {...noAutoCapInputProps} />
      </Form.Item>
      <Form.Item name="weight" label={tr('nacos_service.field.weight')}>
        <InputNumber min={0} max={10000} step={0.1} style={{ width: '100%' }} />
      </Form.Item>
      <Space size="large">
        <Form.Item name="enabled" label={tr('nacos_service.field.enabled')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="ephemeral" label={tr('nacos_service.field.ephemeral')} valuePropName="checked">
          <Switch disabled />
        </Form.Item>
        <Form.Item name="healthy" label={tr('nacos_service.field.healthy')} valuePropName="checked">
          <Switch
            disabled={!editingInstance || !canUpdateInstanceHealth(editingInstance)}
          />
        </Form.Item>
      </Space>
    </Form>
  </Modal>
);
