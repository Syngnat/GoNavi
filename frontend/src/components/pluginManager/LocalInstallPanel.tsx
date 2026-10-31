import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import { pluginAPI } from '../../plugins/api';
import { pluginErrorText } from '../../plugins/apiResult';
import { parsePluginInstallSpec } from '../../plugins/installSpec';
import type { PluginInspection, PluginRemoteInspection } from '../../plugins/types';
import { isWebRuntime } from '../../utils/browserFileTransfer';
import { PluginInstallPreview } from './PluginInstallPreview';
import { pickPluginPackageDirectory, pickPluginPackageFile } from './pluginPackagePicker';
import { consumePendingPluginInstall, subscribePluginInstallDeeplink } from './pluginInstallDeeplink';

interface Props { allowed: boolean; onInstalled: () => void; installedIds?: ReadonlySet<string> }
export function LocalInstallPanel({ allowed, onInstalled, installedIds }: Props) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const [inspection, setInspection] = useState<PluginInspection | null>(null);
  // 远程检查的一次性审批令牌；不进渲染状态，安装/取消/卸载时使用。
  const remoteRef = useRef<PluginRemoteInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<'file' | 'directory' | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const webRuntime = isWebRuntime();
  const cancelRemote = (value: PluginRemoteInspection | null) => {
    if (value) void Promise.resolve(pluginAPI.remoteCancelInspection(value.approvalToken)).catch(() => {});
  };
  const clearInspection = () => {
    cancelRemote(remoteRef.current);
    remoteRef.current = null;
    setInspection(null);
  };
  useEffect(() => () => cancelRemote(remoteRef.current), []);
  const runInspect = async (target: string) => {
    if (!target || !allowed || installing) return;
    const token = ++request.current;
    cancelRemote(remoteRef.current);
    remoteRef.current = null;
    setBusy(true); setError('');
    try {
      const spec = parsePluginInstallSpec(target);
      if (spec.kind === 'local') {
        const result = await pluginAPI.inspect(target);
        if (token === request.current) setInspection(result);
      } else {
        const result = await pluginAPI.remoteInspect(target);
        if (token === request.current) {
          remoteRef.current = result;
          setInspection(result.inspection);
        }
      }
    }
    catch (cause) { if (token === request.current) setError(pluginErrorText(cause)); }
    finally { if (token === request.current) setBusy(false); }
  };
  const runInspectRef = useRef(runInspect);
  runInspectRef.current = runInspect;
  // 市场网站的 gonavi:// 链接在这里落地：spec 自动预填并检查；只有 id 时（市场服务
  // 尚未接入）只预填输入框，由用户自行触发检查。同一链接的重复投递只处理一次。
  const handledDeepLinkRef = useRef('');
  useEffect(() => {
    if (!allowed) return undefined;
    const handle = (payload: { spec?: string; id?: string }) => {
      const target = (payload.spec ?? payload.id ?? '').trim();
      if (!target || handledDeepLinkRef.current === target) return;
      handledDeepLinkRef.current = target;
      request.current++; setBusy(false);
      setPath(target); clearInspection();
      if (payload.spec) void runInspectRef.current(target);
    };
    const pending = consumePendingPluginInstall();
    if (pending) handle(pending);
    return subscribePluginInstallDeeplink(handle);
  }, [allowed]);
  const inspect = () => { if (!busy) void runInspect(path.trim()); };
  const pickPackage = async (directory: boolean) => {
    if (!allowed || installing || picking) return;
    setPicking(directory ? 'directory' : 'file');
    try {
      const picked = directory ? await pickPluginPackageDirectory(path) : await pickPluginPackageFile(path);
      if (picked.status === 'selected') {
        request.current++; setBusy(false); setPath(picked.path); clearInspection();
        await runInspect(picked.path);
      } else if (picked.status === 'failed') {
        setError(t('plugin.install.select_failed'));
      }
    } finally { setPicking(null); }
  };
  return <section className="plugin-local-install plugin-stack" aria-label={t('plugin.install.local')}>
    <header className="plugin-local-install-heading">
      <Typography.Text strong>{t('plugin.install.local')}</Typography.Text>
      <Typography.Text type="secondary">{t('plugin.install.path_hint')}</Typography.Text>
    </header>
    <div className="plugin-toolbar plugin-install-controls">
      <Input aria-label={t('plugin.install.path')} placeholder={t('plugin.install.path')} value={path} disabled={!allowed || installing}
        onChange={(event) => { request.current++; setBusy(false); setPath(event.target.value); clearInspection(); }} onPressEnter={inspect} />
      <Button type="primary" onClick={inspect} loading={busy} disabled={!allowed || installing || !path.trim()}>{t('plugin.install.inspect')}</Button>
    </div>
    {!webRuntime && <div className="plugin-ui-row plugin-install-pickers">
      <Button onClick={() => void pickPackage(false)} loading={picking === 'file'} disabled={!allowed || installing}>{t('plugin.install.select_file')}</Button>
      <Button onClick={() => void pickPackage(true)} loading={picking === 'directory'} disabled={!allowed || installing}>{t('plugin.install.select_directory')}</Button>
    </div>}
    {installing && <Alert type="info" showIcon message={t('plugin.install.in_progress')} />}
    {error && <Alert showIcon type="error" message={error} />}
    {inspection && <PluginInstallPreview key={inspection.digest} inspection={inspection} allowed={allowed} onCancel={clearInspection}
      replace={installedIds?.has(inspection.manifest.id) === true}
      onInstall={async () => {
        setInstalling(true); setError('');
        const remote = remoteRef.current;
        const replacing = installedIds?.has(inspection.manifest.id) === true;
        try {
          if (remote) await pluginAPI.remoteInstall(inspection.digest, true, remote.approvalToken);
          else if (replacing) await pluginAPI.replace(inspection.sourcePath, inspection.digest, true);
          else await pluginAPI.install(inspection.sourcePath, inspection.digest, true);
          clearInspection();
        }
        catch (cause) { setError(pluginErrorText(cause)); throw cause; }
        finally { setInstalling(false); onInstalled(); }
      }} />}
  </section>;
}
