package app

import (
	"errors"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type partialMetadataDatabasesDB struct {
	*releaseRecordingDB
	err error
}

func (f *partialMetadataDatabasesDB) GetDatabases() ([]string, error) {
	f.getDatabasesCalls++
	return f.databases, f.err
}

var _ db.Database = (*partialMetadataDatabasesDB)(nil)

func TestDBGetDatabasesReturnsPartialResultForMetadataWarning(t *testing.T) {
	partialErr := db.NewPartialMetadataError([]db.MetadataObjectFailure{{ObjectName: "restricted", Err: errors.New("metadata read failed")}})
	database := &partialMetadataDatabasesDB{
		releaseRecordingDB: &releaseRecordingDB{databases: []string{"hive.default", "hive.analytics"}},
		err:                partialErr,
	}
	config := connection.ConnectionConfig{Type: "custom", Driver: "mysql"}
	application := NewApp()
	application.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:     database,
		lastPing: time.Now(),
		config:   config,
	}

	result := application.DBGetDatabases(config)
	if !result.Success || !result.Partial || !result.Retryable {
		t.Fatalf("DBGetDatabases result = %#v, want successful partial retryable result", result)
	}
	if len(result.Warnings) != 1 || result.FailedObjectTypes[0] != "database" {
		t.Fatalf("DBGetDatabases metadata fields = %#v, want one database warning", result)
	}
	rows, ok := result.Data.([]map[string]string)
	if !ok || len(rows) != 2 {
		t.Fatalf("DBGetDatabases data = %#v, want two usable databases", result.Data)
	}
}
