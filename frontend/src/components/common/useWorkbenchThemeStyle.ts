import type { CSSProperties } from 'react'
import { theme } from 'antd'
import './workbenchTheme.css'

/** 与 workbenchTheme.css 配套：注入 antd token 作为 --wb-* 的回落值。根节点需同时带上 gn-wb-theme 类名。 */
export function useWorkbenchThemeStyle(): CSSProperties {
  const { token } = theme.useToken()
  return {
    '--wb-tk-bg': token.colorBgLayout,
    '--wb-tk-panel': token.colorBgContainer,
    '--wb-tk-subtle': token.colorFillQuaternary,
    '--wb-tk-border': token.colorBorderSecondary,
    '--wb-tk-text': token.colorText,
    '--wb-tk-muted': token.colorTextSecondary,
    '--wb-tk-primary': token.colorPrimary,
    '--wb-tk-success': token.colorSuccess,
    '--wb-tk-error': token.colorError,
    '--wb-tk-warning': token.colorWarning,
  } as CSSProperties
}
