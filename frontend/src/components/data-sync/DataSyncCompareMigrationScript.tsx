import { useMemo, useState } from 'react';

import { DataSyncSqlBlock } from './DataSyncSqlBlock';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  /** 由调用方按目标端方言渲染好的修复 SQL；空串表示没有可生成语句。 */
  sql: string;
  copyText: (text: string) => Promise<boolean>;
  t: DataSyncWorkbenchTranslate;
};

/**
 * 迁移脚本区：把修复 SQL 按表拆成独立块，每块可单独复制。
 *
 * 拆块按空行分（生成器在表之间插一个空行），这样不会因为 SQL 内部的换行
 * 把一张表切成两段。
 */
export function DataSyncCompareMigrationScript({ sql, copyText, t }: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // 开头的说明性注释块不单独成块：它们属于整个脚本，拼进第一段可执行块里，
  // 避免出现「只有说明、没有语句」的复制按钮。
  const blocks = useMemo(() => {
    const parts = sql.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    let leadingCount = 0;
    while (leadingCount < parts.length &&
      parts[leadingCount]!.split('\n').every((line) => {
        const trimmed = line.trim();
        return !trimmed || trimmed.startsWith('--');
      })) {
      leadingCount += 1;
    }
    if (leadingCount === 0) return parts;
    const rest = parts.slice(leadingCount);
    if (rest.length === 0) return [];
    return [[...parts.slice(0, leadingCount), rest[0]!].join('\n\n'), ...rest.slice(1)];
  }, [sql]);

  const copy = async (text: string) => {
    const ok = await copyText(text);
    setCopyState(ok ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <section
      className="gn-data-sync-compare-migration"
      data-data-sync-compare-migration="true"
    >
      <div className="gn-data-sync-compare-migration__head">
        <strong>{t('compare.migration.title')}</strong>
        <button
          type="button"
          className="gn-data-sync-button"
          data-compare-copy-migration="true"
          disabled={!sql || copyState === 'copied'}
          onClick={() => void copy(sql)}
        >
          {copyState === 'copied'
            ? t('compare.copy.copied')
            : copyState === 'failed'
              ? t('compare.copy.failed')
              : t('compare.migration.copy_all')}
        </button>
      </div>
      {blocks.length === 0 ? (
        <p className="gn-data-sync-compare-migration__empty">
          {t('compare.migration.empty')}
        </p>
      ) : (
        <div className="gn-data-sync-compare-migration__blocks">
          {blocks.map((block, index) => (
            <div key={index} className="gn-data-sync-compare-migration__item">
              <DataSyncSqlBlock sql={block} />
              <button
                type="button"
                className="gn-data-sync-link-button"
                onClick={() => void copy(block)}
              >
                {t('compare.copy.copy_one')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
