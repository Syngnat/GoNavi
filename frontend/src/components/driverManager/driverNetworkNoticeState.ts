// 驱动页网络提示条的关闭状态。
//
// 提示条（镜像不可达但 GitHub 回落可用 / 下载链路不可达）对用户有用 —— 它解释了
// 为什么下载慢 —— 但每次打开驱动页都弹会烦。关闭状态持久化在 localStorage，
// 沿用 driverOptionalUpdate.ts 的既有惯例。
//
// 关闭的粒度是「提示种类」而非「本次检测结果」：网络探测结果每次都会变（延迟、
// 可用性），若按结果哈希记录，用户刚关掉下一次检测就又弹出来。

export const DRIVER_NETWORK_NOTICE_DISMISS_KEY = 'gonavi.driver.networkNotice.dismissed';

/** 提示种类：与渲染分支一一对应，新增分支时在此登记。 */
export type DriverNetworkNoticeKind = 'fallback' | 'unreachable';

/** 读取已关闭的提示种类；localStorage 不可用时返回空数组（即全部显示）。 */
export const readDismissedDriverNetworkNotices = (): DriverNetworkNoticeKind[] => {
  try {
    const raw = window.localStorage.getItem(DRIVER_NETWORK_NOTICE_DISMISS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is DriverNetworkNoticeKind => item === 'fallback' || item === 'unreachable',
    );
  } catch {
    return [];
  }
};

/** 记录一种提示已关闭，返回更新后的列表。localStorage 不可用时仅本次会话内生效。 */
export const dismissDriverNetworkNotice = (
  dismissed: DriverNetworkNoticeKind[],
  kind: DriverNetworkNoticeKind,
): DriverNetworkNoticeKind[] => {
  const next = Array.from(new Set([...dismissed, kind]));
  try {
    window.localStorage.setItem(DRIVER_NETWORK_NOTICE_DISMISS_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可用（隐私模式等）：本次会话内仍按 next 生效
  }
  return next;
};
