import type { DataSyncIndexStructureDiff } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  diffs: DataSyncIndexStructureDiff[];
  t: DataSyncWorkbenchTranslate;
};

// 索引差异单独一段：与列差异分开渲染，用户才能分清「改字段」和「改索引」。
// 索引读不到时后端不下发 indexDiffs，这里自然整段不出现。
export function DataSyncCompareRowIndexes({ diffs, t }: Props) {
  if (diffs.length === 0) return null;
  return (
    <ul
      className="gn-data-sync-compare-row__column-diffs gn-data-sync-compare-row__index-diffs"
      data-data-sync-index-diffs="true"
    >
      {diffs.map((diff) => (
        <li key={`${diff.kind}:${diff.name}`} data-kind={diff.kind}>
          <span className="gn-data-sync-compare-row__diff-kind">
            {t(`compare.index_kind.${diff.kind}`)}
          </span>
          <span
            className="gn-data-sync-compare-row__field"
            data-data-sync-compare-field="true"
          >
            <code className="gn-data-sync-mono">{diff.name}</code>
          </span>
          {diff.kind === 'changed' ? (
            <span className="gn-data-sync-compare-row__diff-detail">
              <code className="gn-data-sync-mono">{diff.source || '—'}</code>
              {' → '}
              <code className="gn-data-sync-mono">{diff.target || '—'}</code>
            </span>
          ) : (
            <span className="gn-data-sync-compare-row__diff-detail">
              <code className="gn-data-sync-mono">
                {diff.source || diff.target || '—'}
              </code>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
