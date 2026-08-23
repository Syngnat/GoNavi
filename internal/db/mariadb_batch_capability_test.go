//go:build gonavi_full_drivers || gonavi_mariadb_driver

package db

import "testing"

func TestMariaDBBatchWriteCapabilityReflectsNegotiatedDSN(t *testing.T) {
	mariaDB := &MariaDB{}
	if _, ok := any(mariaDB).(BatchWriteCapability); !ok {
		t.Fatal("MariaDB must expose runtime batch-write capability")
	}

	mariaDB.batchWritesEnabled = mysqlDSNSupportsBatchWrites("user:pass@tcp(localhost:3306)/app?multiStatements=true")
	if !mariaDB.SupportsBatchWrites() {
		t.Fatal("multiStatements=true MariaDB connection should allow batch writes")
	}

	mariaDB.batchWritesEnabled = mysqlDSNSupportsBatchWrites("user:pass@tcp(localhost:3306)/app?multiStatements=false")
	if mariaDB.SupportsBatchWrites() {
		t.Fatal("multiStatements=false MariaDB connection must disable batch writes")
	}
}
