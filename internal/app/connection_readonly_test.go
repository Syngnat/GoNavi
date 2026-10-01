package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

func TestSupportsConnectionReadOnlyMode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		config connection.ConnectionConfig
		want   bool
	}{
		{name: "postgres", config: connection.ConnectionConfig{Type: "postgres"}, want: true},
		{name: "mongodb", config: connection.ConnectionConfig{Type: "mongodb"}, want: true},
		{name: "nacos", config: connection.ConnectionConfig{Type: "nacos"}, want: true},
		{name: "elasticsearch", config: connection.ConnectionConfig{Type: "elasticsearch"}, want: true},
		{name: "iotdb", config: connection.ConnectionConfig{Type: "iotdb"}, want: true},
		{name: "dameng alias", config: connection.ConnectionConfig{Type: "dm8"}, want: true},
		{name: "custom dameng alias", config: connection.ConnectionConfig{Type: "custom", Driver: "dm"}, want: true},
		{name: "kingbase alias", config: connection.ConnectionConfig{Type: "kingbasees"}, want: true},
		{name: "goldendb alias", config: connection.ConnectionConfig{Type: "greatdb"}, want: true},
		{name: "custom goldendb alias", config: connection.ConnectionConfig{Type: "custom", Driver: "gdb"}, want: true},
		{name: "IoTDB alias", config: connection.ConnectionConfig{Type: "apache_iotdb"}, want: true},
		{name: "IRIS alias", config: connection.ConnectionConfig{Type: "InterSystemsIRIS"}, want: true},
		{name: "Caché alias", config: connection.ConnectionConfig{Type: "InterSystems-Caché"}, want: true},
		{name: "custom driver substring alias", config: connection.ConnectionConfig{Type: "custom", Driver: "postgres-driver"}, want: true},
		{name: "OceanBase Oracle tenant", config: connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}, want: true},
		{name: "custom OceanBase Oracle tenant", config: connection.ConnectionConfig{Type: "custom", Driver: "oceanbase", OceanBaseProtocol: "oracle"}, want: true},
		{name: "redis", config: connection.ConnectionConfig{Type: "redis"}, want: false},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := supportsConnectionReadOnlyMode(test.config); got != test.want {
				t.Fatalf("supportsConnectionReadOnlyMode(%+v) = %v, want %v", test.config, got, test.want)
			}
		})
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
