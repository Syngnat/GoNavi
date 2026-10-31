import { Button, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import { openPluginPageTab } from '../../pluginPages/openPluginPageTab';
import type { PluginStatus } from '../../plugins/types';

interface Props {
  plugin: PluginStatus;
  active: boolean;
  managementAllowed?: boolean;
  webRuntime?: boolean;
}

/**
 * Settings-center entry point: one row per declared page, opening the same workbench tab.
 * A web session without plugin management cannot serve a page call, so the rows are
 * disabled and explained instead of failing after a click.
 */
export function PluginPageList({
  plugin,
  active,
  managementAllowed = true,
  webRuntime = false,
}: Props) {
  const { t } = useI18n();
  const pages = plugin.manifest.contributes?.pages ?? [];
  if (pages.length === 0) return null;
  const blocked = webRuntime && managementAllowed === false;
  const navigation = plugin.manifest.contributes?.navigation ?? [];
  const titleFor = (pageID: string, fallback: string) => (
    navigation.find((entry) => entry.page === pageID && entry.location === 'tools')?.title ?? fallback
  );
  return <section className="plugin-page-list" aria-label={t('plugin.pages.title')}>
    <Typography.Text strong>{t('plugin.pages.title')}</Typography.Text>
    {blocked && <Typography.Text type="secondary" className="plugin-page-list-hint">
      {t('plugin.pages.web_unavailable')}
    </Typography.Text>}
    <ul>
      {pages.map((page) => <li key={page.id}>
        <span>{page.title}</span>
        <Button
          size="small"
          disabled={!active || blocked}
          onClick={() => openPluginPageTab({
            pluginID: plugin.manifest.id,
            pageID: page.id,
            title: titleFor(page.id, page.title),
          })}
        >
          {t('plugin.pages.open')}
        </Button>
      </li>)}
    </ul>
  </section>;
}
