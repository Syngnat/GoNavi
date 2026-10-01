import { useCallback } from 'react';
import { message } from 'antd';

import type { I18nParams } from '../i18n/types';

const NATIVE_MENU_UPDATE_CHECK_TOAST_KEY = 'gonavi-native-menu-update-check';

type CheckForUpdates = (silent: boolean, openReleaseNotes?: boolean) => Promise<void>;
type Translate = (key: string, params?: I18nParams) => string;

/**
 * macOS 菜单栏「关于 → 检查更新」的处理函数。
 *
 * 检查本身完全复用关于页「检查更新」按钮的 checkForUpdates(false, true)：
 * 发现新版本时自动打开更新日志 / 下载弹窗，已是最新或失败时给出提示。
 * 原生菜单没有 loading 状态，关于页也不一定处于打开状态，所以检查期间用一条
 * 带转圈图标的全局提示表示「正在检查」，无论成功、失败都在结束后撤掉。
 */
export const useNativeMenuUpdateCheck = (checkForUpdates: CheckForUpdates, t: Translate) => (
  useCallback(async () => {
    void message.loading({
      content: t('app.about.update_status.checking'),
      key: NATIVE_MENU_UPDATE_CHECK_TOAST_KEY,
      duration: 0,
    });
    try {
      await checkForUpdates(false, true);
    } catch (error) {
      void message.error(t('app.about.message.check_failed_with_error', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      message.destroy(NATIVE_MENU_UPDATE_CHECK_TOAST_KEY);
    }
  }, [checkForUpdates, t])
);
