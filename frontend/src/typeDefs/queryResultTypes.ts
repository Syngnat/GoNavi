import type { connection } from '../../wailsjs/go/models';

/**
 * Structural query result used at boundaries where tests or fallbacks provide
 * plain objects. Generated QueryResult instances remain assignable to it.
 */
export type QueryResultLike = Pick<
  connection.QueryResult,
  'success' | 'message' | 'data'
> & Partial<
  Omit<connection.QueryResult, 'success' | 'message' | 'data'>
>;
