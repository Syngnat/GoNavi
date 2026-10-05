import React from 'react';

import { BUNDLED_BRAND_ICON_ZOOM, RIBBON_TILE_ART_FRACTION, resolveBrandIcon, resolveBrandIconSrc } from '../../brand/brandIcons';
import { useStore } from '../../store';

export const PRESET_ICON_SLUG: Record<string, string> = {
  openai: 'openai',
  codex: 'openai',
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
  // A provider the person points at their own endpoint: a plug.
  custom: 'custom',
};

/** The built-in GoNavi AI is GoNavi itself: its logo is the app's own brand icon, whichever one the person picked. */
export const GONAVI_AI_PRESET_KEY = 'gonavi-ai';

/**
 * A brand icon leaves a transparent margin around its tile (a ribbon icon's tile is
 * 80% of the image, measured), while the other provider marks fill their box, so it
 * would look small beside them. It is enlarged to the same footprint.
 */
export const brandIconZoom = (brandIconId: unknown): number => (
  resolveBrandIcon(brandIconId).slug.startsWith('ribbon-') ? 1 / RIBBON_TILE_ART_FRACTION : BUNDLED_BRAND_ICON_ZOOM
);

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
  const brandIconId = useStore((state) => state.brandIconId);
  const slug = PRESET_ICON_SLUG[presetKey];
  const brandSrc = presetKey === GONAVI_AI_PRESET_KEY ? resolveBrandIconSrc(brandIconId) : '';
  const src = iconPath || brandSrc || (slug ? `/icons/ai/${slug}.svg` : '');
  const invert = Boolean(dark && !iconPath && slug && WHITE_DARK_SLUGS.has(slug));
  const classes = ['gonavi-ai-provider-logo', className].filter(Boolean).join(' ');
  if (src && !failed) {
    const style: React.CSSProperties = {
      ...(invert ? { filter: 'invert(1)' } : {}),
      ...(brandSrc && src === brandSrc ? { transform: `scale(${brandIconZoom(brandIconId)})` } : {}),
    };
    return <img className={classes} src={src} alt="" onError={() => setFailed(true)}
      style={Object.keys(style).length > 0 ? style : undefined} />;
  }
  return <span className={`${classes} is-fallback`} aria-hidden="true">{(label || presetKey).slice(0, 1).toUpperCase()}</span>;
};

export default AIProviderLogo;
