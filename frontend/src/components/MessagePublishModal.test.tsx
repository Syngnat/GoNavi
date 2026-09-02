import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  setFieldsValue: vi.fn(),
  validateFields: vi.fn(),
  dbQueryAudited: vi.fn(),
  confirmProductionMutation: vi.fn(),
  messageError: vi.fn(),
  messageWarning: vi.fn(),
}));

const persistence = vi.hoisted(() => ({
  loadMessagePublishDraft: vi.fn(),
  saveMessagePublishDraft: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  DBQueryAudited: mocks.dbQueryAudited,
}));

vi.mock('../utils/productionRiskConfirm', () => ({
  confirmProductionMutation: mocks.confirmProductionMutation,
}));

vi.mock('../utils/messageWorkbenchPersistence', () => persistence);

vi.mock('../i18n/provider', async () => {
  const catalog = (await import('../../../shared/i18n/zh-CN.json')).default as Record<string, string>;
  const translate = (key: string, params: Record<string, unknown> = {}) => {
    let text = catalog[key] || key;
    Object.entries(params).forEach(([name, value]) => {
      text = text.split(`{{${name}}}`).join(String(value ?? ''));
    });
    return text;
  };
  return { useI18n: () => ({ t: translate }) };
});

vi.mock('antd', () => {
  const Form = ({ children, ...props }: any) => <form {...props}>{children}</form>;
  Form.Item = ({ children, label, name, rules }: any) => (
    <div
      data-form-item={String(name || '')}
      data-label={String(label || '')}
      data-required={rules?.some((rule: any) => rule?.required) ? 'true' : 'false'}
    >
      {children}
    </div>
  );
  Form.useForm = () => [{
    setFieldsValue: mocks.setFieldsValue,
    validateFields: mocks.validateFields,
  }];
  const Input = Object.assign(
    (props: any) => <input {...props} />,
    { TextArea: (props: any) => <textarea {...props} /> },
  );

  return {
    Alert: ({ message }: any) => <div>{message}</div>,
    Checkbox: ({ children }: any) => <label>{children}</label>,
    Form,
    Input,
    Select: ({ options, ...props }: any) => (
      <select {...props}>
        {(options || []).map((option: any) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    ),
    Space: Object.assign(
      ({ children }: any) => <div>{children}</div>,
      { Compact: ({ children }: any) => <div>{children}</div> },
    ),
    Typography: { Text: ({ children }: any) => <span>{children}</span> },
    message: { error: mocks.messageError, warning: mocks.messageWarning },
  };
});

vi.mock('./common/ResizableDraggableModal', () => ({
  default: ({ children, open, onOk }: any) => (
    open ? (
      <section data-testid="message-publish-modal">
        {children}
        <button data-testid="message-publish-confirm" onClick={onOk}>send</button>
      </section>
    ) : null
  ),
}));

import MessagePublishModal from './MessagePublishModal';

const rabbitConnection = {
  id: 'rabbit-1',
  name: 'RabbitMQ',
  config: {
    type: 'rabbitmq',
    host: '127.0.0.1',
    port: 15672,
    database: '/',
    connectionParams: 'defaultQueue=orders.queue',
  },
} as any;

const mqttConnection = {
  id: 'mqtt-1',
  name: 'MQTT',
  config: {
    type: 'mqtt',
    host: '127.0.0.1',
    port: 1883,
  },
} as any;

describe('MessagePublishModal RabbitMQ exchange target', () => {
  beforeEach(() => {
    mocks.values = {};
    mocks.setFieldsValue.mockReset();
    mocks.setFieldsValue.mockImplementation((values: Record<string, unknown>) => {
      mocks.values = { ...mocks.values, ...values };
    });
    mocks.validateFields.mockReset();
    mocks.validateFields.mockImplementation(async () => ({ ...mocks.values }));
    mocks.dbQueryAudited.mockReset();
    mocks.dbQueryAudited.mockResolvedValue({ success: true, data: { affectedRows: 1 } });
    mocks.confirmProductionMutation.mockReset();
    mocks.confirmProductionMutation.mockResolvedValue(true);
    mocks.messageError.mockReset();
    mocks.messageWarning.mockReset();
    persistence.loadMessagePublishDraft.mockReset();
    persistence.loadMessagePublishDraft.mockReturnValue(null);
    persistence.saveMessagePublishDraft.mockReset();
    persistence.saveMessagePublishDraft.mockReturnValue(true);
  });

  it('uses Exchange plus optional Routing Key without requiring a Queue', async () => {
    const onSuccess = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MessagePublishModal
          open
          connection={rabbitConnection}
          executionDbName="/"
          defaultExchange="events.fanout"
          onCancel={() => undefined}
          onSuccess={onSuccess}
        />,
      );
    });

    expect(renderer.root.findAllByProps({ 'data-form-item': 'destination' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-form-item': 'exchange' }).props['data-label'])
      .toBe('交换机（可选）');
    expect(renderer.root.findByProps({ 'data-form-item': 'routingKey' }).props['data-label'])
      .toBe('路由键（可选）');
    expect(renderer.root.findByProps({ 'data-form-item': 'routingKey' }).props['data-required'])
      .toBe('false');
    expect(mocks.values).toMatchObject({
      destination: '',
      exchange: 'events.fanout',
      routingKey: '',
    });

    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'message-publish-confirm' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbQueryAudited).toHaveBeenCalledWith(
      expect.anything(),
      '/',
      expect.stringContaining('"exchange": "events.fanout"'),
      'message_publish',
    );
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      destination: 'events.fanout',
      affectedRows: 1,
    }));
  });

  it('renders the MQTT publish form entirely in zh-CN apart from protocol names', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MessagePublishModal
          open
          connection={mqttConnection}
          onCancel={() => undefined}
        />,
      );
    });

    expect(renderer.root.findByProps({ 'data-form-item': 'destination' }).props['data-label'])
      .toBe('主题');
    expect(renderer.root.findByProps({ 'data-form-item': 'qos' }).props['data-label'])
      .toBe('QoS');
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('保留消息');
    expect(rendered).toContain('最多一次');
    expect(rendered).toContain('至少一次');
    expect(rendered).toContain('当前表单会自动生成 MQTT JSON 发布命令');
    expect(rendered).toContain('通过消息代理发送测试消息');
    expect(rendered).toContain('表单草稿按连接保存在本机');
    expect(rendered).not.toMatch(/\bTopic\b|Retain|At most once|At least once|broker|affectedRows/);
  });

  it('restores and continuously persists an MQTT publish draft in its workspace scope', () => {
    let storedDraft = {
      destination: 'saved/topic',
      qos: 2,
      retain: true,
      bodyMode: 'text' as const,
      body: 'saved payload',
    };
    persistence.loadMessagePublishDraft.mockImplementation(() => storedDraft);
    persistence.saveMessagePublishDraft.mockImplementation((_connectionId, _dbName, draft) => {
      storedDraft = { ...draft };
      return true;
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MessagePublishModal
          open
          connection={mqttConnection}
          executionDbName="topics"
          onCancel={() => undefined}
        />,
      );
    });

    expect(persistence.loadMessagePublishDraft).toHaveBeenCalledWith('mqtt-1', 'topics');
    expect(mocks.values).toMatchObject({
      destination: 'saved/topic',
      qos: 2,
      retain: true,
      bodyMode: 'text',
      body: 'saved payload',
    });

    const changedDraft = {
      destination: 'changed/topic',
      qos: 1,
      retain: false,
      bodyMode: 'json',
      body: '{"changed":true}',
    };
    const form = renderer.root.findByType('form');
    expect(form.props.onValuesChange).toEqual(expect.any(Function));
    act(() => { form.props.onValuesChange({}, changedDraft); });
    expect(persistence.saveMessagePublishDraft).toHaveBeenCalledWith(
      'mqtt-1',
      'topics',
      changedDraft,
    );

    act(() => { renderer.unmount(); });
    mocks.values = {};
    act(() => {
      renderer = create(
        <MessagePublishModal
          open
          connection={mqttConnection}
          executionDbName="topics"
          onCancel={() => undefined}
        />,
      );
    });
    expect(mocks.values).toMatchObject(changedDraft);
  });

  it('lets an explicit object target override only the saved destination context', () => {
    persistence.loadMessagePublishDraft.mockReturnValue({
      destination: 'saved/topic',
      qos: 2,
      retain: true,
      bodyMode: 'text',
      body: 'keep this payload',
    });

    act(() => {
      create(
        <MessagePublishModal
          open
          connection={mqttConnection}
          executionDbName="topics"
          defaultDestination="tree/topic"
          onCancel={() => undefined}
        />,
      );
    });

    expect(mocks.values).toMatchObject({
      destination: 'tree/topic',
      qos: 2,
      retain: true,
      bodyMode: 'text',
      body: 'keep this payload',
    });
  });

  it('warns only once when publish-draft persistence is unavailable', () => {
    persistence.saveMessagePublishDraft.mockReturnValue(false);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MessagePublishModal
          open
          connection={mqttConnection}
          executionDbName="topics"
          onCancel={() => undefined}
        />,
      );
    });

    const form = renderer.root.findByType('form');
    const draft = {
      destination: 'warning/topic',
      qos: 0,
      retain: false,
      bodyMode: 'text',
      body: 'payload',
    };
    act(() => {
      form.props.onValuesChange({}, draft);
      form.props.onValuesChange({}, { ...draft, body: 'payload-2' });
    });

    expect(mocks.messageWarning).toHaveBeenCalledTimes(1);
    expect(mocks.messageWarning).toHaveBeenCalledWith(
      '无法保存消息工作台配置，请检查本地存储空间或权限',
    );
  });

  it('does not carry a saved RabbitMQ Exchange into an explicit Queue target', () => {
    persistence.loadMessagePublishDraft.mockReturnValue({
      destination: '',
      exchange: 'old.exchange',
      routingKey: 'old.key',
      bodyMode: 'text',
      body: 'keep this payload',
    });

    act(() => {
      create(
        <MessagePublishModal
          open
          connection={rabbitConnection}
          executionDbName="/"
          defaultDestination="new.queue"
          onCancel={() => undefined}
        />,
      );
    });

    expect(mocks.values).toMatchObject({
      destination: 'new.queue',
      exchange: '',
      routingKey: 'new.queue',
      bodyMode: 'text',
      body: 'keep this payload',
    });
  });
});
