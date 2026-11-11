import { normalizeCommentText } from '../queryEditorCompletionMetadata';

/**
 * 补全右侧详情列的统一格式：「注释 - 对象类型」。
 *
 * 类型固定在整行最末端，这样同一列的类型文本不会因为有没有注释而左右移动。
 * typeLabel 形如「表 (db) / 视图 (db.schema) / 存储过程 (db)」，已含对象类型
 * 与其限定名。
 *
 * 全局补全与限定名补全共用这一处，避免两边格式漂移。
 */
export const buildCompletionDetailTypeLast = (typeLabel: string, comment?: string): string => (
  [normalizeCommentText(comment), typeLabel].filter(Boolean).join(' - ')
);
