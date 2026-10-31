package db

import "context"

var _ ReadOnlyQueryContexter = (*MySQLDB)(nil)

// QueryReadOnlyContext requires a server-side read-only transaction; unsupported
// servers and the stateless Navicat HTTP tunnel return an error from BeginTx.
func (m *MySQLDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return querySQLReadOnlyContext(ctx, m.conn, query)
}
