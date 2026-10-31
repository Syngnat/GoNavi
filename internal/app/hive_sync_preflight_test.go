package app

import (
	"context"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	syncengine "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

type hivePreflightTarget struct {
	db.Database
	exists       bool
	capabilities db.HiveTableWriteCapabilities
	checks       int
	probes       int
}

func (target *hivePreflightTarget) TableExists(string, string) (bool, error) {
	target.checks++
	return target.exists, nil
}
func (target *hivePreflightTarget) HiveTableWriteCapabilities(ctx context.Context, table string) (db.HiveTableWriteCapabilities, error) {
	if ctx.Err() != nil {
		return db.HiveTableWriteCapabilities{}, ctx.Err()
	}
	target.probes++
	return target.capabilities, nil
}

func TestHivePersistentPreflightUsesActualTableCapabilities(t *testing.T) {
	for _, test := range []struct {
		name, mode         string
		capabilities       db.HiveTableWriteCapabilities
		deletes, wantError bool
	}{
		{"ordinary append", "insert_only", db.HiveTableWriteCapabilities{Insert: true, Truncate: true}, false, false},
		{"ordinary delta", "insert_update", db.HiveTableWriteCapabilities{Insert: true}, false, true},
		{"acid delta and delete", "insert_update", db.HiveTableWriteCapabilities{Insert: true, Update: true, Delete: true}, true, false},
		{"external cannot overwrite", "full_overwrite", db.HiveTableWriteCapabilities{Insert: true}, false, true},
		{"managed overwrite", "full_overwrite", db.HiveTableWriteCapabilities{Insert: true, Truncate: true}, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			target := &hivePreflightTarget{exists: true, capabilities: test.capabilities}
			config := syncengine.SyncConfig{SourceConfig: connection.ConnectionConfig{Type: "hive"}, TargetConfig: connection.ConnectionConfig{Type: "hive"}, Mode: test.mode, Content: "data"}
			definition := syncjob.JobDefinition{}
			definition.Options.PropagateDeletes = test.deletes
			mapping := syncjob.TableMapping{TargetTable: "orders"}
			endpoint := resolvedDataSyncJobEndpoint{Config: config.TargetConfig, Database: "analytics"}
			err := inspectHiveSyncTargetMode(context.Background(), target, config, definition, mapping, endpoint)
			if (err != nil) != test.wantError || target.checks != 1 || target.probes != 1 {
				t.Fatalf("table capability preflight=%v checks=%d probes=%d", err, target.checks, target.probes)
			}
		})
	}
}

func TestHivePersistentPreflightStopsBeforeMetadataWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	target := &hivePreflightTarget{exists: true}
	err := inspectHiveSyncTargetMode(ctx, target, syncengine.SyncConfig{}, syncjob.JobDefinition{}, syncjob.TableMapping{}, resolvedDataSyncJobEndpoint{})
	if !errors.Is(err, context.Canceled) || target.checks != 0 || target.probes != 0 {
		t.Fatalf("cancelled preflight performed metadata: %v %+v", err, target)
	}
}
