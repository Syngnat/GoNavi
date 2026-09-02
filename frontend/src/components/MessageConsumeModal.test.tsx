import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  setFieldsValue: vi.fn(),
  validateFields: vi.fn(),
  messageError: vi.fn(),
}));

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
  const Form = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children, label, name, rules }: any) => (
    <div
      data-form-item={String(name || '')}
      data-label={String(label || '')}
      data-required={rules?.some((rule: any) => rule?.required) ? 'true' : 'false'}
    >
      <span>{label}</span>
      {children}
    </div>
  );
  Form.useForm = () => [{
    setFieldsValue: mocks.setFieldsValue,
    validateFields: mocks.validateFields,
  }];

  return {
    Alert: ({ message, type }: any) => (
      <div data-alert-type={type}>{message}</div>
    ),
    Descriptions: ({ items }: any) => (
      <dl>
        {(items || []).map((item: any) => (
          <React.Fragment key={item.key}>
            <dt>{item.label}</dt>
            <dd>{item.children}</dd>
          </React.Fragment>
        ))}
      </dl>
    ),
    Form,
    Input: (props: any) => <input data-input="text" {...props} />,
    InputNumber: (props: any) => <input data-input="number" {...props} />,
    Select: ({ options, ...props }: any) => (
      <select data-input="select" {...props}>
        {(options || []).map((option: any) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    ),
    Space: ({ children }: any) => <div>{children}</div>,
    Tag: ({ children }: any) => <span>{children}</span>,
    message: {
      error: mocks.messageError,
    },
  };
});

vi.mock('./common/ResizableDraggableModal', () => ({
  default: ({ children, open, onOk, okText, title }: any) => (
    open ? (
      <section data-testid="message-consume-modal" data-ok-text={okText}>
        <h1>{title}</h1>
        {children}
        <button data-testid="message-consume-confirm" onClick={onOk}>confirm</button>
      </section>
    ) : null
  ),
}));

import MessageConsumeModal from './MessageConsumeModal';

const mqttConnection = {
  id: 'mqtt-1',
  name: 'MQTT',
  config: {
    type: 'mqtt',
    connectionParams: 'qos=1&fetchWaitMs=4000&cleanSession=true',
  },
} as any;

const rabbitConnection = {
  id: 'rabbit-1',
  name: 'RabbitMQ',
  config: {
    type: 'rabbitmq',
    database: '/',
    connectionParams: 'defaultQueue=orders.queue',
  },
} as any;

const renderModal = (
  connection: any,
  options: {
    defaultDestination?: string;
    onConfirm?: ReturnType<typeof vi.fn>;
  } = {},
): { renderer: ReactTestRenderer; onConfirm: ReturnType<typeof vi.fn> } => {
  const onConfirm = options.onConfirm || vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MessageConsumeModal
        open
        connection={connection}
        defaultDestination={options.defaultDestination}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    );
  });
  return { renderer, onConfirm };
};

const confirm = async (renderer: ReactTestRenderer): Promise<void> => {
  await act(async () => {
    renderer.root.findByProps({ 'data-testid': 'message-consume-confirm' }).props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('MessageConsumeModal', () => {
  beforeEach(() => {
    mocks.values = {};
    mocks.setFieldsValue.mockReset();
    mocks.setFieldsValue.mockImplementation((values: Record<string, unknown>) => {
      mocks.values = { ...mocks.values, ...values };
    });
    mocks.validateFields.mockReset();
    mocks.validateFields.mockImplementation(async () => {
      if (!String(mocks.values.destination || '').trim()) {
        throw new Error('destination required');
      }
      return { ...mocks.values };
    });
    mocks.messageError.mockReset();
  });

  it('blocks confirmation when the MQTT Topic Filter is empty', async () => {
    const { renderer, onConfirm } = renderModal(mqttConnection);

    const destinationField = renderer.root.findByProps({ 'data-form-item': 'destination' });
    expect(destinationField.props['data-label']).toBe('主题过滤器');
    expect(destinationField.props['data-required']).toBe('true');

    await confirm(renderer);

    expect(mocks.validateFields).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(mocks.messageError).not.toHaveBeenCalled();
  });

  it('submits the prefilled MQTT object target and effective QoS command', async () => {
    const { renderer, onConfirm } = renderModal(mqttConnection, {
      defaultDestination: 'devices/+/telemetry',
    });

    expect(mocks.values).toMatchObject({
      destination: 'devices/+/telemetry',
      qos: 1,
      limit: 100,
    });
    expect(renderer.root.findByProps({ 'data-form-item': 'qos' })).toBeTruthy();
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('清理会话');
    expect(rendered).toContain('最多一次');
    expect(rendered).toContain('至少一次');
    expect(rendered).not.toMatch(/Topic Filter|Clean session|At most once|At least once/);

    await confirm(renderer);

    expect(onConfirm).toHaveBeenCalledWith({
      draft: {
        destination: 'devices/+/telemetry',
        qos: 1,
        limit: 100,
      },
      command: {
        commandText: 'CONSUME FROM "devices/+/telemetry" QOS 1 LIMIT 100;',
        destinationLabel: 'devices/+/telemetry',
        mode: 'stream',
      },
    });
  });

  it('renders RabbitMQ Queue pull-preview copy without a QoS field', () => {
    const { renderer } = renderModal(rabbitConnection);
    const modal = renderer.root.findByProps({ 'data-testid': 'message-consume-modal' });
    const destinationField = renderer.root.findByProps({ 'data-form-item': 'destination' });
    const alert = renderer.root.findByProps({ 'data-alert-type': 'warning' });

    expect(destinationField.props['data-label']).toBe('队列');
    expect(modal.props['data-ok-text']).toBe('预览队列消息');
    expect(alert.children).toContain('通过 RabbitMQ 管理接口读取并重新入队；这是非破坏性的队列预览，不是真正的 AMQP 消费者。');
    expect(renderer.root.findAllByProps({ 'data-form-item': 'qos' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-input': 'select' })).toHaveLength(0);
  });
});
