import { createGnIcon } from '../icons/gnIcon';

/**
 * 用户管理专用线性图标。
 * 线宽、圆角与 GoNavi 图标家族（icons/gnIcons）保持一致，通用动作（新建/刷新/搜索等）直接复用家族图标。
 */

/** 用户：头像 + 肩线。 */
export const GnUserIcon = createGnIcon('user', (
  <>
    <circle cx="12" cy="8" r="3.7" />
    <path d="M4.9 20.2c.5-3.9 3.4-6.2 7.1-6.2s6.6 2.3 7.1 6.2" />
  </>
));

/** 角色 / 用户组：前后两个头像。 */
export const GnUsersIcon = createGnIcon('users', (
  <>
    <circle cx="9.2" cy="8.2" r="3.3" />
    <path d="M2.9 19.6c.5-3.6 3-5.6 6.3-5.6s5.8 2 6.3 5.6" />
    <path d="M15.4 5.2a3.3 3.3 0 0 1 0 6.2" />
    <path d="M17.3 14.3c2.2.5 3.6 2.3 3.9 5.1" />
  </>
));

/** 登录名（SQL Server login）：带勾的盾牌。 */
export const GnShieldIcon = createGnIcon('shield', (
  <>
    <path d="M12 3 4.8 5.9v5.7c0 4.4 3 7.7 7.2 9.4 4.2-1.7 7.2-5 7.2-9.4V5.9z" />
    <path d="m8.9 12.1 2.2 2.2 4-4.3" />
  </>
));

/** 超级用户：王冠。 */
export const GnCrownIcon = createGnIcon('crown', (
  <>
    <path d="m4 8.2 4.3 3.6L12 5l3.7 6.8L20 8.2l-1.5 9.5h-13z" />
    <path d="M6.4 20.4h11.2" />
  </>
));

/** 已锁定。 */
export const GnLockIcon = createGnIcon('lock', (
  <>
    <rect x="5.2" y="10.6" width="13.6" height="9.8" rx="2.6" />
    <path d="M8.4 10.6V8a3.6 3.6 0 0 1 7.2 0v2.6" />
    <path d="M12 14.6v2" />
  </>
));

export const GnEyeIcon = createGnIcon('eye', (
  <>
    <path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </>
));

export const GnEyeOffIcon = createGnIcon('eye-off', (
  <>
    <path d="M9.9 6a9.6 9.6 0 0 1 2.1-.2C18 5.8 21.2 12 21.2 12a17 17 0 0 1-2.5 3.3M6.1 7.9A16.6 16.6 0 0 0 2.8 12S6 18.2 12 18.2c1.4 0 2.6-.3 3.7-.8" />
    <path d="M10 10a2.8 2.8 0 0 0 4 4" />
    <path d="m4 4 16 16" />
  </>
));

/** 模式 / 架构：叠放的三层。 */
export const GnSchemaIcon = createGnIcon('schema', (
  <>
    <path d="m12 3.6 8.4 4.4-8.4 4.4L3.6 8z" />
    <path d="m3.6 12 8.4 4.4 8.4-4.4" />
    <path d="m3.6 16 8.4 4.4 8.4-4.4" />
  </>
));

/** 提示信息。 */
export const GnInfoIcon = createGnIcon('info', (
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11.2v5" />
    <circle cx="12" cy="7.9" r="1.1" fill="currentColor" stroke="none" />
  </>
));

/** 完成 / 无待办。 */
export const GnCheckCircleIcon = createGnIcon('check-circle', (
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m8.4 12.2 2.6 2.6 4.8-5.2" />
  </>
));

/** 失败。 */
export const GnCloseCircleIcon = createGnIcon('close-circle', (
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
  </>
));

/** 已跳过。 */
export const GnMinusCircleIcon = createGnIcon('minus-circle', (
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M8.6 12h6.8" />
  </>
));

/** 树 / 折叠的展开箭头：默认朝右，展开时由样式旋转 90°。 */
export const GnChevronIcon = createGnIcon('chevron', <path d="m9.5 6 6 6-6 6" />);
