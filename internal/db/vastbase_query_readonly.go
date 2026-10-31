//go:build gonavi_full_drivers || gonavi_vastbase_driver

package db

import "context"

var _ ReadOnlyQueryContexter = (*VastbaseDB)(nil)

// QueryReadOnlyContext executes Vastbase queries in a server-enforced read-only transaction.
func (v *VastbaseDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return querySQLReadOnlyContext(ctx, v.conn, query)
}
