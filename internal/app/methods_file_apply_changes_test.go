package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestApplyChangesReturnsDetailedSQLPreview(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	fakeDB := &fakeCreateDatabaseDB{
		previewDeletes: []string{"DELETE FROM `users` WHERE `id` = 7;"},
		previewUpdates: []string{"UPDATE `users` SET `name` = 'new-name' WHERE `id` = 8;"},
		previewInserts: []string{"INSERT INTO `users` (`id`, `name`) VALUES (9, 'created');"},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := NewAppWithSecretStore(secretstore.NewUnavailableStore("test")).ApplyChanges(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"},
		"main",
		"users",
		connection.ChangeSet{
			Deletes: []map[string]interface{}{{"id": 7}},
			Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": 8}, Values: map[string]interface{}{"name": "new-name"}}},
			Inserts: []map[string]interface{}{{"id": 9, "name": "created"}},
		},
	)

	if !result.Success {
		t.Fatalf("ApplyChanges returned failure: %s", result.Message)
	}
	preview, ok := result.Data.(ChangePreview)
	if !ok {
		t.Fatalf("ApplyChanges result data = %#v, want ChangePreview", result.Data)
	}
	if len(preview.Deletes) != 1 || len(preview.Updates) != 1 || len(preview.Inserts) != 1 {
		t.Fatalf("ApplyChanges preview = %#v, want all change statements", preview)
	}
	if len(fakeDB.applyChanges.Deletes) != 1 || len(fakeDB.applyChanges.Updates) != 1 || len(fakeDB.applyChanges.Inserts) != 1 {
		t.Fatalf("ApplyChanges did not send the full change set to the driver: %#v", fakeDB.applyChanges)
	}
	if fakeDB.previewTableName != "users" || fakeDB.applyTableName != "users" {
		t.Fatalf("non-Oracle target changed unexpectedly: preview=%q apply=%q", fakeDB.previewTableName, fakeDB.applyTableName)
	}
}

func TestApplyChangesQualifiesOceanBaseOracleTargetWithSelectedSchema(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}
	driverRuntimeSupportStatusFunc = func(driverType string) (bool, string) {
		return true, ""
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	config := connection.ConnectionConfig{
		Type:              "oceanbase",
		OceanBaseProtocol: "oracle",
		Host:              "127.0.0.1",
		Port:              2881,
	}
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.ApplyChanges(
		config,
		"APP",
		"USERS",
		connection.ChangeSet{
			Updates: []connection.UpdateRow{{
				Keys:   map[string]interface{}{"ID": 7},
				Values: map[string]interface{}{"UPDATED_AT": "2026-07-13 13:42:00"},
			}},
		},
	)

	if !result.Success {
		t.Fatalf("ApplyChanges returned failure: %s", result.Message)
	}
	if fakeDB.previewTableName != "APP.USERS" {
		t.Fatalf("PreviewChanges table = %q, want APP.USERS", fakeDB.previewTableName)
	}
	if fakeDB.applyTableName != "APP.USERS" {
		t.Fatalf("ApplyChanges table = %q, want APP.USERS", fakeDB.applyTableName)
	}

	fakeDB.previewTableName = ""
	previewResult := app.PreviewChanges(config, "APP", "USERS", connection.ChangeSet{})
	if !previewResult.Success {
		t.Fatalf("PreviewChanges returned failure: %s", previewResult.Message)
	}
	if fakeDB.previewTableName != "APP.USERS" {
		t.Fatalf("standalone PreviewChanges table = %q, want APP.USERS", fakeDB.previewTableName)
	}
}

func TestBuildChangePreviewQuotesQualifiedOracleTargetBySegment(t *testing.T) {
	preview := buildChangePreview(
		&fakeBatchWriteDB{},
		connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"},
		"APP.USERS",
		connection.ChangeSet{Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"ID": 7},
			Values: map[string]interface{}{"STATUS": "0"},
		}}},
	)

	want := `UPDATE "APP"."USERS" SET "STATUS" = '0' WHERE "ID" = 7;`
	if len(preview.Updates) != 1 || preview.Updates[0] != want {
		t.Fatalf("qualified Oracle preview = %#v, want %q", preview.Updates, want)
	}
}

func TestResolveChangeTargetTableNamePreservesDamengSchemaContainingDot(t *testing.T) {
	config := connection.ConnectionConfig{Type: "dameng"}
	tests := []struct {
		name      string
		dbName    string
		tableName string
		want      string
	}{
		{
			name:      "flattened metadata name",
			dbName:    "PEM2.4_V1_1",
			tableName: "PEM2.4_V1_1.COM_APPROVE_INFO",
			want:      `"PEM2.4_V1_1"."COM_APPROVE_INFO"`,
		},
		{
			name:      "already quoted target",
			dbName:    "PEM2.4_V1_1",
			tableName: `"PEM2.4_V1_1"."COM_APPROVE_INFO"`,
			want:      `"PEM2.4_V1_1"."COM_APPROVE_INFO"`,
		},
		{
			name:      "unqualified table",
			dbName:    "PEM2.4_V1_1",
			tableName: "COM_APPROVE_INFO",
			want:      `"PEM2.4_V1_1"."COM_APPROVE_INFO"`,
		},
		{
			name:      "table name also contains dot",
			dbName:    "PEM2.4_V1_1",
			tableName: "PEM2.4_V1_1.ORDER.ITEM",
			want:      `"PEM2.4_V1_1"."ORDER.ITEM"`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := resolveChangeTargetTableName(config, test.dbName, test.tableName)
			if got != test.want {
				t.Fatalf("Dameng change target = %q, want %q", got, test.want)
			}
		})
	}
}

func TestBuildChangePreviewPreservesDamengSchemaContainingDot(t *testing.T) {
	preview := buildChangePreview(
		&fakeBatchWriteDB{},
		connection.ConnectionConfig{Type: "dameng"},
		`"PEM2.4_V1_1"."COM_APPROVE_INFO"`,
		connection.ChangeSet{Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"ID": 7},
			Values: map[string]interface{}{"STATUS": "0"},
		}}},
	)

	want := `UPDATE "PEM2.4_V1_1"."COM_APPROVE_INFO" SET "STATUS" = '0' WHERE "ID" = 7;`
	if len(preview.Updates) != 1 || preview.Updates[0] != want {
		t.Fatalf("Dameng preview = %#v, want %q", preview.Updates, want)
	}
}
