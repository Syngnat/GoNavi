package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/syncjob"
)

type blockingPreflightPingDatabase struct {
	fakeMetadataRetryDB
	started chan struct{}
	once    sync.Once
}

type blockingPreflightMetadataDatabase struct {
	fakeMetadataRetryDB
	started chan struct{}
	once    sync.Once
}

func (database *blockingPreflightMetadataDatabase) GetColumns(_, _ string) ([]connection.ColumnDefinition, error) {
	ctx := db.MetadataContext(database)
	database.once.Do(func() { close(database.started) })
	<-ctx.Done()
	return nil, ctx.Err()
}

func (database *blockingPreflightPingDatabase) PingContext(ctx context.Context) error {
	database.once.Do(func() { close(database.started) })
	<-ctx.Done()
	return ctx.Err()
}

func TestDataSyncJobPreflightContextStopsAfterPingCancellation(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	source := &blockingPreflightPingDatabase{started: make(chan struct{})}
	target := &fakeMetadataRetryDB{}
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	newDatabaseFunc = func(databaseType string) (db.Database, error) {
		if databaseType == "mysql" {
			return source, nil
		}
		return target, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	for _, input := range []connection.SavedConnectionInput{
		{ID: "source", Name: "source", Config: connection.ConnectionConfig{ID: "source", Type: "mysql", Host: "source.local", Port: 3306, Database: "source_db"}},
		{ID: "target", Name: "target", Config: connection.ConnectionConfig{ID: "target", Type: "postgres", Host: "target.local", Port: 5432, Database: "target_db"}},
	} {
		if _, err := application.SaveConnection(input); err != nil {
			t.Fatal(err)
		}
	}
	definition := syncjob.JobDefinition{
		Name:            "cancelled preflight",
		Lifecycle:       syncjob.JobLifecycleReady,
		Kind:            syncjob.JobKindReconcile,
		IncrementalMode: syncjob.IncrementalSnapshot,
		Source:          syncjob.EndpointRef{ConnectionID: "source", Database: "source_db"},
		Target:          syncjob.EndpointRef{ConnectionID: "target", Database: "target_db"},
		Mappings: []syncjob.TableMapping{{
			SourceTable: "orders",
			TargetTable: "orders_archive",
			Enabled:     true,
		}},
		Options: syncjob.ExecutionOptions{
			Content:             "data",
			SyncMode:            "insert_update",
			TargetTableStrategy: "existing_only",
			BatchSize:           1000,
			ErrorPolicy:         syncjob.ErrorPolicyStop,
			RetryBackoffMillis:  500,
		},
		Schedule: syncjob.ScheduleSpec{Kind: syncjob.ScheduleManual},
	}

	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan DataSyncJobPreflightResult, 1)
	go func() {
		resultCh <- application.preflightDataSyncJobContext(ctx, definition, time.Now())
	}()
	select {
	case <-source.started:
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for preflight ping")
	}

	select {
	case result := <-resultCh:
		if result.Success || result.Status != "blocked" {
			t.Fatalf("preflight result = %+v, want blocked cancellation", result)
		}
		if len(result.Issues) != 1 || result.Issues[0].Code != "request_cancelled" || result.Issues[0].Message != context.Canceled.Error() {
			t.Fatalf("preflight issues = %#v, want one request_cancelled issue", result.Issues)
		}
		if target.connectCalls != 0 {
			t.Fatalf("target connect calls = %d, want no work after cancellation", target.connectCalls)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("preflight did not return after PingContext cancellation")
	}
}

func TestDataSyncJobPreflightContextStopsAfterMetadataCancellation(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	source := &blockingPreflightMetadataDatabase{started: make(chan struct{})}
	target := &fakeMetadataRetryDB{}
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	newDatabaseFunc = func(databaseType string) (db.Database, error) {
		if databaseType == "mysql" {
			return source, nil
		}
		return target, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	for _, input := range []connection.SavedConnectionInput{
		{ID: "source", Name: "source", Config: connection.ConnectionConfig{ID: "source", Type: "mysql", Host: "source.local", Port: 3306, Database: "source_db"}},
		{ID: "target", Name: "target", Config: connection.ConnectionConfig{ID: "target", Type: "postgres", Host: "target.local", Port: 5432, Database: "target_db"}},
	} {
		if _, err := application.SaveConnection(input); err != nil {
			t.Fatal(err)
		}
	}
	definition := syncjob.JobDefinition{
		Name:            "cancelled metadata preflight",
		Lifecycle:       syncjob.JobLifecycleReady,
		Kind:            syncjob.JobKindReconcile,
		IncrementalMode: syncjob.IncrementalSnapshot,
		Source:          syncjob.EndpointRef{ConnectionID: "source", Database: "source_db"},
		Target:          syncjob.EndpointRef{ConnectionID: "target", Database: "target_db"},
		Mappings: []syncjob.TableMapping{{
			SourceTable: "orders",
			TargetTable: "orders_archive",
			Enabled:     true,
		}},
		Options: syncjob.ExecutionOptions{
			Content:             "data",
			SyncMode:            "insert_update",
			TargetTableStrategy: "existing_only",
			BatchSize:           1000,
			ErrorPolicy:         syncjob.ErrorPolicyStop,
			RetryBackoffMillis:  500,
		},
		Schedule: syncjob.ScheduleSpec{Kind: syncjob.ScheduleManual},
	}

	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan DataSyncJobPreflightResult, 1)
	go func() {
		resultCh <- application.preflightDataSyncJobContext(ctx, definition, time.Now())
	}()
	select {
	case <-source.started:
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for preflight metadata query")
	}

	select {
	case result := <-resultCh:
		if result.Success || result.Status != "blocked" {
			t.Fatalf("preflight result = %+v, want blocked cancellation", result)
		}
		if len(result.Issues) != 1 || result.Issues[0].Code != "request_cancelled" || result.Issues[0].Message != context.Canceled.Error() {
			t.Fatalf("preflight issues = %#v, want one request_cancelled issue", result.Issues)
		}
		if target.columnCalls != 0 {
			t.Fatalf("target metadata calls = %d, want no work after cancellation", target.columnCalls)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("preflight did not return after metadata cancellation")
	}
}
