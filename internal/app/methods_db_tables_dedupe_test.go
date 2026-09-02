package app

import (
	"reflect"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestDBGetTablesDeduplicatesOnlyExactMetadataNamesAtAppBoundary(t *testing.T) {
	config := connection.ConnectionConfig{
		Type:     "mysql",
		Database: "ldf_server_dbs_dev",
	}
	database := &fakeMetadataRetryDB{tables: []string{
		"ldf_server.ldf_application_type",
		"ldf_server.ldf_application_type",
		"archive.ldf_application_type",
		"LDF_SERVER.LDF_APPLICATION_TYPE",
	}}
	application := NewApp()
	application.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:     database,
		lastPing: time.Now(),
		config:   config,
	}

	result := application.DBGetTables(config, config.Database)
	if !result.Success {
		t.Fatalf("DBGetTables returned failure: %s", result.Message)
	}
	rows, ok := result.Data.([]map[string]string)
	if !ok {
		t.Fatalf("DBGetTables data type = %T, want []map[string]string", result.Data)
	}
	got := make([]string, 0, len(rows))
	for _, row := range rows {
		got = append(got, row["Table"])
	}
	want := []string{
		"ldf_server.ldf_application_type",
		"archive.ldf_application_type",
		"LDF_SERVER.LDF_APPLICATION_TYPE",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DBGetTables returned %v, want %v", got, want)
	}
}

func TestDBGetDatabasesDeduplicatesOnlyExactMetadataNamesAtAppBoundary(t *testing.T) {
	config := connection.ConnectionConfig{Type: "custom", Driver: "mysql"}
	database := &releaseRecordingDB{databases: []string{
		"ldf_server_dbs_dev",
		"ldf_server_dbs_dev",
		"archive",
		"LDF_SERVER_DBS_DEV",
	}}
	application := NewApp()
	application.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:   database,
		config: config,
	}

	result := application.DBGetDatabases(config)
	if !result.Success {
		t.Fatalf("DBGetDatabases returned failure: %s", result.Message)
	}
	rows, ok := result.Data.([]map[string]string)
	if !ok {
		t.Fatalf("DBGetDatabases data type = %T, want []map[string]string", result.Data)
	}
	got := make([]string, 0, len(rows))
	for _, row := range rows {
		got = append(got, row["Database"])
	}
	want := []string{
		"ldf_server_dbs_dev",
		"archive",
		"LDF_SERVER_DBS_DEV",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DBGetDatabases returned %v, want %v", got, want)
	}
}

func TestDedupeMetadataNamesPreservesSignificantWhitespace(t *testing.T) {
	tableNames := []string{
		"  tenant table  ",
		"tenant table",
		"  tenant table  ",
		"\t",
	}
	if got, want := dedupeMetadataTableNames(tableNames), []string{"  tenant table  ", "tenant table"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupeMetadataTableNames returned %v, want %v", got, want)
	}

	databaseNames := []string{
		"  tenant database  ",
		"tenant database",
		"  tenant database  ",
		"\n",
	}
	if got, want := dedupeMetadataDatabaseNames(databaseNames), []string{"  tenant database  ", "tenant database"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupeMetadataDatabaseNames returned %v, want %v", got, want)
	}
}
