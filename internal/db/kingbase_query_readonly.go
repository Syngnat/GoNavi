//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import "context"

var _ ReadOnlyQueryContexter = (*KingbaseDB)(nil)

// QueryReadOnlyContext executes Kingbase queries in a server-enforced read-only transaction.
func (k *KingbaseDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return querySQLReadOnlyContext(ctx, k.conn, query)
}
