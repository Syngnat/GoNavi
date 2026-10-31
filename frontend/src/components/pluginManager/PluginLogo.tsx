import { useEffect, useState, type ReactNode } from 'react';
import { PluginIcon } from '../../../wailsjs/go/app/App';

// 图标按「插件 + 版本」缓存：同一卡片重渲染、翻页回来都不再走一次绑定调用。
const iconCache = new Map<string, string>();

interface Props {
  pluginId: string;
  name: string;
  version: string;
  variant?: 'card' | 'toolbar';
  fallback?: ReactNode;
}

// 插件 Logo 复用宿主的栅格图标读取与缓存，工具栏可提供默认图标回退。
export function PluginLogo({ pluginId, name, version, variant = 'card', fallback }: Props) {
  const key = `${pluginId}@${version}`;
  const [image, setImage] = useState(() => ({ key, src: iconCache.get(key) ?? '' }));
  const src = image.key === key ? image.src : '';
  useEffect(() => {
    setImage({ key, src: iconCache.get(key) ?? '' });
    if (iconCache.has(key)) return;
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
  }, [key, pluginId]);
  const monogram = (name.trim().charAt(0) || '?').toUpperCase();
  const content = src
    ? <img className="plugin-logo-image" src={src} alt="" onError={() => {
      iconCache.set(key, ''); setImage({ key, src: '' });
    }} />
    : fallback ?? <span className="plugin-logo-monogram" aria-hidden>{monogram}</span>;
  return variant === 'toolbar'
    ? <span className="plugin-toolbar-logo" data-loaded={src ? 'true' : 'false'}>{content}</span>
    : <div className="plugin-logo" data-loaded={src ? 'true' : 'false'}>{content}</div>;
}
