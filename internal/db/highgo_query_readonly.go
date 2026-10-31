//go:build gonavi_full_drivers || gonavi_highgo_driver

package db

import "context"

var _ ReadOnlyQueryContexter = (*HighGoDB)(nil)

// QueryReadOnlyContext executes HighGo queries in a server-enforced read-only transaction.
func (h *HighGoDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return querySQLReadOnlyContext(ctx, h.conn, query)
}
