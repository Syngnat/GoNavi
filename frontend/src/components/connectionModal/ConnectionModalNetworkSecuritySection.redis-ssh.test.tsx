import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { t } from '../../i18n';
import ConnectionModalNetworkSecuritySection from './ConnectionModalNetworkSecuritySection';

// 按项目既有测试模式 mock antd：真实 Form.useWatch 在 react-test-renderer 下的
// 订阅时机不可靠，且 antd/图标组件在 node 环境会向 DOM 注入样式。
// formApi 通过 globalThis 暴露给用例，供组件内 form.getFieldValue 等直接调用。
const state = vi.hoisted(() => ({
  mockFormValues: {} as Record<string, unknown>,
}));

vi.mock('antd', () => {
  const formApi = {
    getFieldValue: (name: string) => state.mockFormValues[name],
    setFieldValue: (name: string, value: unknown) => {
      state.mockFormValues[name] = value;
    },
  };
  (globalThis as any).__gonaviNetworkSectionTestFormApi = formApi;
  const Form: any = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children, name }: any) => (
    <div data-form-item={String(name ?? '')}>
      {typeof children === 'function' ? children(formApi) : children}
    </div>
  );
  Form.useForm = () => [formApi];
  Form.useWatch = (name: string) => state.mockFormValues[name];
  const Checkbox = ({ disabled, checked, onClick, children }: any) => (
    <label>
      <input
        type="checkbox"
        disabled={disabled === true}
        checked={checked === true}
        onClick={(event) => onClick?.(event)}
        readOnly
      />
      {children}
    </label>
  );
  const Button = ({ onClick, children }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  const Input: any = (props: any) => <input {...props} />;
  Input.Password = Input;
  Input.TextArea = Input;
  const InputNumber = (props: any) => <input type="number" {...props} />;
  const Select = ({ children }: any) => <select>{children}</select>;
  Select.Option = ({ children }: any) => <option>{children}</option>;
  return { Form, Checkbox, Button, Input, InputNumber, Select };
});

const renderSection = async (
  formValues: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<ReactTestRenderer> => {
  state.mockFormValues = { ...formValues };
  let renderer: ReactTestRenderer | undefined;
  const Harness = () => (
    <ConnectionModalNetworkSecuritySection
      dbType={String(overrides.dbType ?? "redis")}
      form={(globalThis as any).__gonaviNetworkSectionTestFormApi}
      activeNetworkConfig="ssh"
      setActiveNetworkConfig={() => undefined}
      isSSLType={false}
      isFileDb={false}
      isJVM={false}
      initialValues={{}}
      handleSelectCertificateFile={() => undefined}
      handleSelectSSHKeyFile={() => undefined}
      handleSelectSSHKnownHostsFile={
        (overrides.handleSelectSSHKnownHostsFile as (() => void) | undefined) ??
        (() => undefined)
      }
      renderStoredSecretControls={() => null}
      proxyType="socks5"
      selectingCertificateField={null}
      selectingSSHKey={null}
      selectingSSHKnownHosts={false}
      sslHintText=""
      sslMode=""
      supportsSSLCAPath={false}
      supportsSSLClientCertificate={false}
      useHttpTunnel={false}
      useProxy={false}
      useSSH={overrides.useSSH === true}
      useSSL={false}
    />
  );
  await act(async () => {
    renderer = create(<Harness />);
  });
  return renderer!;
};

// 只收集可见文本叶子节点，避免 data-form-item 等属性名（如 keepAliveEnabled）
// 干扰状态文案断言。
const collectTextLeaves = (node: unknown, acc: string[]): string[] => {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectTextLeaves(child, acc));
    return acc;
  }
  if (node && typeof node === 'object') {
    const children = (node as { children?: unknown }).children;
    if (children) collectTextLeaves(children, acc);
  }
  return acc;
};

const findAllText = (renderer: ReactTestRenderer): string =>
  collectTextLeaves(renderer.toJSON(), []).join('\n');

const findSshCheckboxDisabled = (renderer: ReactTestRenderer): boolean | undefined => {
  const formItem = renderer.root.findAll(
    (node) => node.props?.['data-form-item'] === 'useSSH',
  )[0];
  if (!formItem) return undefined;
  const input = formItem.findAllByType('input')[0];
  return input?.props.disabled === true;
};

const UNSUPPORTED_HINT = t('connection.modal.network.ssh.redisTopologyUnsupportedHint');
const DISABLE_ACTION = t('connection.modal.network.ssh.disableAction');

describe('ConnectionModalNetworkSecuritySection redis SSH topology gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables the SSH checkbox for Redis Cluster and shows the reason', async () => {
    const renderer = await renderSection({ redisTopology: 'cluster', useSSH: false });
    expect(findSshCheckboxDisabled(renderer)).toBe(true);
    expect(findAllText(renderer)).toContain(UNSUPPORTED_HINT);
    expect(findAllText(renderer)).not.toContain(DISABLE_ACTION);
  });

  it('disables the SSH checkbox for Redis Sentinel and shows the reason', async () => {
    const renderer = await renderSection({ redisTopology: 'sentinel', useSSH: false });
    expect(findSshCheckboxDisabled(renderer)).toBe(true);
    expect(findAllText(renderer)).toContain(UNSUPPORTED_HINT);
  });

  it('keeps a loaded conflicting SSH config recoverable with an explicit disable action', async () => {
    const renderer = await renderSection({ redisTopology: 'cluster', useSSH: true });
    expect(findSshCheckboxDisabled(renderer)).toBe(true);
    const text = findAllText(renderer);
    expect(text).toContain(UNSUPPORTED_HINT);
    expect(text).toContain(DISABLE_ACTION);
    // 行状态与详情面板标题都不能再把冲突配置描述为「已启用」。
    expect(text).toContain(t('connection.modal.network.unsupported'));
    expect(text).not.toContain(t('connection.modal.network.enabled'));
  });

  it('keeps SSH available for standalone Redis', async () => {
    const renderer = await renderSection({ redisTopology: 'single', useSSH: false });
    expect(findSshCheckboxDisabled(renderer)).toBe(false);
    const text = findAllText(renderer);
    expect(text).not.toContain(UNSUPPORTED_HINT);
    expect(text).toContain(t('connection.modal.network.ssh.disabledHint'));
  });

  it('keeps server identity verification automatic instead of exposing known_hosts or fingerprint inputs', async () => {
    const selectKnownHosts = vi.fn();
    const renderer = await renderSection(
      { useSSH: true },
      {
        dbType: 'mysql',
        useSSH: true,
        handleSelectSSHKnownHostsFile: selectKnownHosts,
      },
    );

    const text = findAllText(renderer);
    expect(text).not.toContain(t('connection.modal.network.ssh.knownHostsFile'));
    expect(text).not.toContain(t('connection.modal.network.ssh.hostKeyFingerprintShort'));
    expect(text).toContain(t('connection.modal.network.ssh.hostKeyAutomaticHint'));

    const browseButtons = renderer.root.findAllByType('button').filter(
      (node) => collectTextLeaves(node.children, []).join('') === t('connection.modal.action.browse'),
    );
    expect(browseButtons).toHaveLength(1);
    expect(selectKnownHosts).not.toHaveBeenCalled();
  });
});
