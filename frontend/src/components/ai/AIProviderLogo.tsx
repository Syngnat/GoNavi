import React from 'react';
import { AppstoreOutlined } from '@ant-design/icons';

export const PRESET_ICON_SLUG: Record<string, string> = {
  openai: 'openai',
  deepseek: 'deepseek',
  'qwen-bailian': 'alibabacloud',
  'qwen-coding-plan': 'alibabacloud',
  anthropic: 'anthropic',
  'claude-subscription': 'claudecode',
  grok: 'grok',
  gemini: 'googlegemini',
  minimax: 'minimax',
  codebuddy: 'codebuddy',
  cursor: 'cursor',
  'cursor-cli': 'cursor',
  ollama: 'ollama',
  atlascloud: 'atlascloud',
  orcarouter: 'orcarouter',
  zhipu: 'zhipu',
  moonshot: 'moonshot',
  'xiaomi-mimo': 'xiaomimimo',
  'volcengine-ark': 'volcengine',
  'volcengine-coding': 'volcengine',
};

const WHITE_DARK_SLUGS = new Set(['openai', 'anthropic', 'ollama', 'cursor', 'grok', 'claudecode', 'atlascloud']);

export interface AIProviderLogoProps {
  presetKey: string;
  label: string;
  iconPath?: string;
  dark?: boolean;
  className?: string;
}

export const AIProviderLogo: React.FC<AIProviderLogoProps> = ({
  presetKey,
  label,
  iconPath,
  dark = false,
  className,
}) => {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => { setFailed(false); }, [presetKey, iconPath]);
  const slug = PRESET_ICON_SLUG[presetKey];
  const src = iconPath || (slug ? `/icons/ai/${slug}.svg` : '');
  const invert = Boolean(dark && !iconPath && slug && WHITE_DARK_SLUGS.has(slug));
  const classes = ['gonavi-ai-provider-logo', className].filter(Boolean).join(' ');
  if (presetKey === 'custom') {
    return <span className={classes} aria-hidden="true"><AppstoreOutlined /></span>;
  }
  if (src && !failed) {
    return <img className={classes} src={src} alt="" onError={() => setFailed(true)}
      style={invert ? { filter: 'invert(1)' } : undefined} />;
  }
  return <span className={`${classes} is-fallback`} aria-hidden="true">{(label || presetKey).slice(0, 1).toUpperCase()}</span>;
};

export default AIProviderLogo;
