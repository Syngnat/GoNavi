//go:build gonavi_full_drivers || gonavi_mariadb_driver

package db

import (
	"database/sql"
	"testing"
)

func TestMariaDBMetadataQueriesQuoteIdentifiersAndBindNames(t *testing.T) {
	const schema = "app`prod"
	const table = "order'items"

	capture := &mysqlMetadataQuotingCapture{}
	conn := sql.OpenDB(mysqlMetadataQuotingConnector{capture: capture})
	t.Cleanup(func() { _ = conn.Close() })
	db := &MariaDB{conn: conn}
	if _, err := db.GetIndexes(schema, table); err != nil {
		t.Fatalf("GetIndexes returned error: %v", err)
	}
	if _, err := db.GetForeignKeys(schema, table); err != nil {
		t.Fatalf("GetForeignKeys returned error: %v", err)
	}
	if _, err := db.GetTriggers(schema, table); err != nil {
		t.Fatalf("GetTriggers returned error: %v", err)
	}
	assertMySQLCompatibleMetadataQueryCapture(t, capture, schema, table)
}
