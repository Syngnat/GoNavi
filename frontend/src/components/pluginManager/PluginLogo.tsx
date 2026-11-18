import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PluginIcon } from '../../../wailsjs/go/app/App';

// 图标按「插件 + 版本」缓存：同一卡片重渲染、翻页回来都不再走一次绑定调用。
const iconCache = new Map<string, string>();
const EMPTY_SOURCES: string[] = [];
const REMOTE_RETRY_DELAYS_MS = [700, 1800];

interface Props {
  pluginId: string;
  name: string;
  version: string;
  variant?: 'card' | 'toolbar';
  fallback?: ReactNode;
  // 市场卡片先用未安装状态渲染；安装完成后置为 true，允许重试空缓存。
  installed?: boolean;
  // 未安装插件从市场来源解析出的远程候选图；本机图标为空时按顺序尝试。
  remoteSources?: string[];
  // 兼容单个远程地址的旧调用。
  remoteSrc?: string;
  // 手动刷新目录时递增，失败过的远程图可以重新尝试。
  retryKey?: string | number;
}

// 插件 Logo 复用宿主的栅格图标读取与缓存，工具栏可提供默认图标回退。
export function PluginLogo({ pluginId, name, version, variant = 'card', fallback, installed = false, remoteSources, remoteSrc = '', retryKey = 0 }: Props) {
  const key = `${pluginId}@${version}`;
  const sources = remoteSources?.length ? remoteSources : remoteSrc ? [remoteSrc] : EMPTY_SOURCES;
  const remoteKey = sources.join('\n');
  const [image, setImage] = useState(() => ({ key, src: iconCache.get(key) ?? '' }));
  const [remoteIndex, setRemoteIndex] = useState(0);
  const [remoteAttempt, setRemoteAttempt] = useState(0);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const src = image.key === key ? image.src : '';
  const remote = !remoteFailed ? sources[remoteIndex] ?? '' : '';
  useEffect(() => {
    const cached = iconCache.get(key) ?? '';
    setImage({ key, src: cached });
    // 安装状态变化时重试空缓存；有图时直接复用缓存。
    if (cached) return;
    let alive = true;
    // 绑定调用在非 Wails 环境中可能同步抛错，统一转成拒绝并回退。
    Promise.resolve()
      .then(() => PluginIcon(pluginId))
      .then((value) => {
        iconCache.set(key, value ?? '');
        if (alive) setImage({ key, src: value ?? '' });
      })
      .catch(() => {
        iconCache.set(key, '');
        if (alive) setImage({ key, src: '' });
      });
    return () => { alive = false; };
  }, [key, pluginId, installed]);
  useEffect(() => {
    setRemoteIndex(0);
    setRemoteAttempt(0);
    setRemoteFailed(false);
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, [remoteKey, retryKey]);
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);
  const onRemoteError = () => {
    if (remoteIndex + 1 < sources.length) {
      setRemoteIndex(remoteIndex + 1);
      return;
    }
    const delay = REMOTE_RETRY_DELAYS_MS[remoteAttempt];
    if (delay === undefined) {
      setRemoteFailed(true);
      return;
    }
    // 冷启动时图片服务可能尚未就绪；短暂隐藏图片后重试同一候选。
    setRemoteFailed(true);
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      setRemoteIndex(0);
      setRemoteAttempt(remoteAttempt + 1);
      setRemoteFailed(false);
    }, delay);
  };
  const monogram = (name.trim().charAt(0) || '?').toUpperCase();
  const content = src
    ? <img className="plugin-logo-image" src={src} alt="" onError={() => {
      iconCache.set(key, ''); setImage({ key, src: '' });
    }} />
    : remote
    ? <img key={`${remote}:${remoteAttempt}:${remoteIndex}`} className="plugin-logo-image" src={remote} alt="" onError={onRemoteError} />
    : fallback ?? <span className="plugin-logo-monogram" aria-hidden>{monogram}</span>;
  const loaded = src || remote;
  return variant === 'toolbar'
    ? <span className="plugin-toolbar-logo" data-loaded={loaded ? 'true' : 'false'}>{content}</span>
    : <div className="plugin-logo" data-loaded={loaded ? 'true' : 'false'}>{content}</div>;
}
