package app

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/plugin"
)

type schemaWriteContextProbe struct {
	db.Database
	exec func(context.Context, string) (int64, error)
}

func (*schemaWriteContextProbe) Connect(connection.ConnectionConfig) error { return nil }
func (*schemaWriteContextProbe) Close() error                              { return nil }
func (*schemaWriteContextProbe) Ping() error                               { return nil }
func (probe *schemaWriteContextProbe) ExecContext(ctx context.Context, sql string) (int64, error) {
	return probe.exec(ctx, sql)
}

func TestPluginSchemaApplyPropagatesContextAndStopsBetweenStatements(t *testing.T) {
	a := newPluginTestApp(t)
	ctx, cancel := context.WithCancel(a.ctx)
	defer cancel()
	calls := 0
	inheritedCancellation := false
	probe := &schemaWriteContextProbe{exec: func(driverCtx context.Context, _ string) (int64, error) {
		calls++
		cancel()
		inheritedCancellation = driverCtx.Err() != nil
		return 1, nil
	}}
	original := newDatabaseFunc
	newDatabaseFunc = func(string) (db.Database, error) { return probe, nil }
	t.Cleanup(func() { newDatabaseFunc = original })
	if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{ID: "context-schema", Name: "Context", Config: connection.ConnectionConfig{Type: "postgres", Host: "db.internal"}}); err != nil {
		t.Fatal(err)
	}
	status := runningSchemaWriteStatus(t, a, "test.schema.context")
	preview, err := a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, "schema.preview", json.RawMessage(`{"connectionId":"context-schema","statements":["CREATE TABLE first (id INT)","CREATE TABLE second (id INT)"]}`))
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Data pluginCapabilitySchemaPreviewResult `json:"data"`
	}
	if err := json.Unmarshal(preview, &envelope); err != nil || envelope.Data.PlanID == "" {
		t.Fatalf("preview: %s %v", preview, err)
	}
	a.schemaConfirm = func(context.Context, string) (bool, error) { return true, nil }
	args, err := json.Marshal(pluginCapabilitySchemaApplyArguments{PlanID: envelope.Data.PlanID})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, "schema.apply", args)
	if err != nil {
		t.Fatal(err)
	}
	if ok, code := decodePluginCapabilityEnvelope(t, raw); ok || code != "internal" {
		t.Errorf("cancelled apply: %s", raw)
	}
	if !inheritedCancellation {
		t.Error("driver context did not inherit request cancellation")
	}
	if calls != 1 {
		t.Fatalf("expected only first DDL, got %d executions", calls)
	}
}

func TestPluginSchemaApplyCancellationDuringConfirmationDoesNotExecute(t *testing.T) {
	a := newPluginTestApp(t)
	database := &fakeBatchWriteDB{}
	original := newDatabaseFunc
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	t.Cleanup(func() { newDatabaseFunc = original })
	if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{ID: "cancel-schema", Name: "Cancel", Config: connection.ConnectionConfig{Type: "postgres", Host: "db.internal"}}); err != nil {
		t.Fatal(err)
	}
	status := plugin.Status{Manifest: pluginPageTestManifest("test.schema.cancel", plugin.SchemaWritePermission), Generation: 1, State: plugin.StateRunning, DesiredEnabled: true}
	preview, err := a.pluginCapabilityCall(a.ctx, status, pluginCapabilityChannelWindow, "schema.preview", json.RawMessage(`{"connectionId":"cancel-schema","statements":["CREATE TABLE cancelled (id INT)"]}`))
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Data pluginCapabilitySchemaPreviewResult `json:"data"`
	}
	if err := json.Unmarshal(preview, &envelope); err != nil || envelope.Data.PlanID == "" {
		t.Fatalf("preview: %s %v", preview, err)
	}
	ctx, cancel := context.WithCancel(a.ctx)
	defer cancel()
	a.schemaConfirm = func(context.Context, string) (bool, error) { cancel(); return true, nil }
	args, err := json.Marshal(pluginCapabilitySchemaApplyArguments{PlanID: envelope.Data.PlanID})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, "schema.apply", args)
	if err != nil {
		t.Fatal(err)
	}
	if ok, code := decodePluginCapabilityEnvelope(t, raw); ok || code != "internal" {
		t.Errorf("cancelled apply: %s", raw)
	}
	if database.execCalls != 0 || database.batchCalls != 0 {
		t.Fatalf("cancelled confirmation dispatched DDL: exec=%d batch=%d", database.execCalls, database.batchCalls)
	}
}

func TestPluginSchemaApplyExecutesOnlyAfterConfirmation(t *testing.T) {
	a := newPluginTestApp(t)
	a.ctx = context.Background()
	a.headlessRuntime = false
	a.webRuntime = false
	config := connection.ConnectionConfig{Type: "sqlite", Database: filepath.Join(t.TempDir(), "schema.db")}
	probe := a.DBQueryMultiWithOptions(config, "", "SELECT 1", "", QueryResultBudgetOptions{})
	if !probe.Success && (strings.Contains(probe.Message, "SQLite 纯 Go 驱动未启用") || strings.Contains(probe.Message, "SQLite Go driver is not enabled")) {
		t.Skip("SQLite optional driver is not enabled in this test environment")
	}
	if !probe.Success {
		t.Fatalf("sqlite probe failed: %s", probe.Message)
	}
	if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{ID: "schema-exec", Name: "Schema Exec", Config: config}); err != nil {
		t.Fatal(err)
	}
	status := runningSchemaWriteStatus(t, a, "test.schema.exec")
	preview := func(sql string) string {
		arguments, _ := json.Marshal(map[string]any{"connectionId": "schema-exec", "statements": []string{sql}})
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "schema.preview", arguments)
		if err != nil {
			t.Fatal(err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		if !ok || code != "" {
			t.Fatalf("preview envelope: %s", raw)
		}
		var envelope struct {
			Data pluginCapabilitySchemaPreviewResult `json:"data"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Data.PlanID == "" {
			t.Fatalf("preview data: %s %v", raw, err)
		}
		return envelope.Data.PlanID
	}
	apply := func(planID string) (bool, string) {
		arguments, _ := json.Marshal(map[string]string{"planId": planID})
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "schema.apply", arguments)
		if err != nil {
			t.Fatal(err)
		}
		return decodePluginCapabilityEnvelope(t, raw)
	}
	tableExists := func(name string) bool {
		result := a.DBQueryMultiWithOptions(config, "", "SELECT name FROM sqlite_master WHERE type='table' AND name='"+name+"'", "", QueryResultBudgetOptions{})
		if !result.Success {
			t.Fatalf("sqlite check failed: %+v", result)
		}
		data, _ := json.Marshal(result.Data)
		return strings.Contains(string(data), name)
	}

	deniedPlan := preview("CREATE TABLE denied_table (id INTEGER)")
	a.schemaConfirm = func(context.Context, string) (bool, error) { return false, nil }
	if ok, code := apply(deniedPlan); ok || code != "confirmation_denied" {
		t.Fatalf("denied apply envelope: %v %s", ok, code)
	}
	if tableExists("denied_table") {
		t.Fatal("denied DDL was executed")
	}

	allowedPlan := preview("CREATE TABLE allowed_table (id INTEGER)")
	a.schemaConfirm = func(context.Context, string) (bool, error) { return true, nil }
	if ok, code := apply(allowedPlan); !ok || code != "" {
		t.Fatalf("allowed apply envelope: %v %s", ok, code)
	}
	if !tableExists("allowed_table") {
		t.Fatal("confirmed DDL did not execute")
	}
}
