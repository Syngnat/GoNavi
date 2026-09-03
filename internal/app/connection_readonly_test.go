package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

func TestSupportsConnectionReadOnlyMode(t *testing.T) {
	if !supportsConnectionReadOnlyMode(connection.ConnectionConfig{Type: "postgres"}) {
		t.Fatal("postgres should support connection-level production guard")
	}
	if !supportsConnectionReadOnlyMode(connection.ConnectionConfig{Type: "mongodb"}) {
		t.Fatal("mongodb should support connection-level production guard")
	}
	if !supportsConnectionReadOnlyMode(connection.ConnectionConfig{Type: "nacos"}) {
		t.Fatal("nacos should support connection-level production guard")
	}
	if !supportsConnectionReadOnlyMode(connection.ConnectionConfig{Type: "elasticsearch"}) {
		t.Fatal("elasticsearch should support connection-level production guard")
	}
	if supportsConnectionReadOnlyMode(connection.ConnectionConfig{Type: "redis"}) {
		t.Fatal("redis should not support connection-level production guard")
	}
}

func TestEnsureReadOnlyConnectionAllowsQuery(t *testing.T) {
	sqlConfig := connection.ConnectionConfig{Type: "postgres", ReadOnly: true}
	if err := ensureConnectionAllowsQuery(sqlConfig, "SELECT * FROM users"); err != nil {
		t.Fatalf("read-only postgres connection should allow select: %v", err)
	}
	if err := ensureConnectionAllowsQuery(sqlConfig, "UPDATE users SET name = 'next'"); err == nil {
		t.Fatal("read-only postgres connection should block update")
	}
	if err := ensureConnectionAllowsQuery(sqlConfig, "SELECT ARRAY[[1,2],[3,4]]; DELETE FROM users"); err == nil {
		t.Fatal("read-only postgres connection should block a write after an array expression")
	}

	mongoConfig := connection.ConnectionConfig{Type: "mongodb", ReadOnly: true}
	if err := ensureConnectionAllowsQuery(mongoConfig, `{"find":"users","filter":{"active":true}}`); err != nil {
		t.Fatalf("read-only mongodb connection should allow find: %v", err)
	}
	if err := ensureConnectionAllowsQuery(mongoConfig, `{"delete":"users","deletes":[{"q":{"active":false},"limit":0}]}`); err == nil {
		t.Fatal("read-only mongodb connection should block delete")
	}
	if err := ensureConnectionAllowsQuery(mongoConfig, `{"distinct":"users","key":"status","query":{}}`); err != nil {
		t.Fatalf("read-only mongodb connection should allow distinct: %v", err)
	}
	if err := ensureConnectionAllowsQuery(mongoConfig, `{"aggregate":"users","pipeline":[{"$match":{}}]}`); err != nil {
		t.Fatalf("read-only mongodb connection should allow aggregate: %v", err)
	}
	if err := ensureConnectionAllowsQuery(mongoConfig, `{"aggregate":"users","pipeline":[{"$out":"archive"}]}`); err == nil {
		t.Fatal("read-only mongodb connection should block aggregate write stage")
	}
	if err := ensureConnectionAllowsQuery(mongoConfig, `{"aggregate":"users","pipeline":[{"$merge":{"into":"archive"}}]}`); err == nil {
		t.Fatal("read-only mongodb connection should block aggregate merge stage")
	}
}

func TestEnsureReadOnlyConnectionAllowsAction(t *testing.T) {
	setDefaultAppLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		setDefaultAppLanguage(i18n.LanguageEnUS)
	})

	config := connection.ConnectionConfig{Type: "postgres", ReadOnly: true}
	err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_database")
	if err == nil {
		t.Fatal("read-only connection should block mutating actions")
	}
	if !strings.Contains(err.Error(), defaultAppText("connection.backend.action.drop_database", nil)) {
		t.Fatalf("blocked action message should include action label, got %q", err.Error())
	}
}

func TestEnsureConnectionProtectionSeparatesActionCategories(t *testing.T) {
	config := connection.ConnectionConfig{
		Type: "postgres",
		Protection: connection.ConnectionProtectionConfig{
			RestrictDataEdit:      true,
			RestrictDataImport:    true,
			RestrictStructureEdit: false,
		},
	}

	if err := ensureConnectionAllowsQuery(config, "UPDATE users SET name = 'next'"); err != nil {
		t.Fatalf("script execution should remain allowed when only data-edit/import restrictions are enabled: %v", err)
	}
	if err := ensureConnectionAllowsDataEdit(config, "connection.backend.action.apply_result_changes"); err == nil {
		t.Fatal("data edit restriction should block result changes")
	}
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.import_data"); err == nil {
		t.Fatal("data import restriction should block imports")
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_database"); err != nil {
		t.Fatalf("structure edits should remain allowed when structure restriction is disabled: %v", err)
	}
}
