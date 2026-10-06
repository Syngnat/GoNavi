package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func newConnectionImportTestApp(t *testing.T) *App {
	t.Helper()
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	return app
}

var connectionImportExcelFixtureColumns = []string{"name", "type", "host", "port", "user", "password", "group", "dsn"}

func writeConnectionsExcelFixture(t *testing.T, rows []map[string]interface{}) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "connections.xlsx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create excel: %v", err)
	}
	writer, err := newXLSXExportFileWriter(file, 0)
	if err != nil {
		t.Fatalf("create writer: %v", err)
	}
	if err := writer.SetColumns(connectionImportExcelFixtureColumns); err != nil {
		t.Fatalf("set columns: %v", err)
	}
	for _, row := range rows {
		if err := writer.ConsumeRow(row); err != nil {
			t.Fatalf("write row: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close file: %v", err)
	}
	return path
}

// vulcanizerExcelRows mirrors the reported workbook: one SQL Server per
// machine, grouped by production line, each machine on its own address.
func vulcanizerExcelRows(lines []string, machinesPerLine int) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(lines)*machinesPerLine)
	for lineIndex, line := range lines {
		for machine := 1; machine <= machinesPerLine; machine++ {
			rows = append(rows, map[string]interface{}{
				"name":     fmt.Sprintf("%s%02d", line, machine),
				"type":     "sqlserver",
				"host":     fmt.Sprintf("172.19.%d.%d", 91+lineIndex, machine),
				"port":     "1433",
				"user":     "sa",
				"password": "secret",
				"group":    "硫化机/" + line + "列",
			})
		}
	}
	return rows
}

func mustSavedConnectionCount(t *testing.T, app *App) int {
	t.Helper()
	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections: %v", err)
	}
	return len(saved)
}

func TestConnectionImportIdentity(t *testing.T) {
	base := connection.ConnectionConfig{Type: "sqlserver", Host: "172.19.91.1", Port: 1433, User: "sa"}
	tunnel := func(host string) connection.ConnectionConfig {
		config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root", UseSSH: true}
		config.SSH = connection.SSHConfig{Host: host, Port: 22, User: "ops"}
		return config
	}
	tuned := base
	tuned.Timeout = 30
	tuned.SSLMode = "preferred"
	tuned.KeepAliveEnabled = true
	tuned.Password = "changed"
	otherHost := base
	otherHost.Host = "172.19.91.2"
	otherPort := base
	otherPort.Port = 1434
	otherUser := base
	otherUser.User = "reader"
	otherDatabase := base
	otherDatabase.Database = "mes"
	upperHost := base
	upperHost.Host = "DB.Example.COM"
	lowerHost := base
	lowerHost.Host = "db.example.com"

	tests := []struct {
		name      string
		leftName  string
		left      connection.ConnectionConfig
		rightName string
		right     connection.ConnectionConfig
		wantSame  bool
	}{
		{name: "identical", leftName: "A01", left: base, rightName: "A01", right: base, wantSame: true},
		{name: "surrounding spaces in name", leftName: " A01 ", left: base, rightName: "A01", right: base, wantSame: true},
		{name: "tuning fields rewritten by the edit form", leftName: "A01", left: base, rightName: "A01", right: tuned, wantSame: true},
		{name: "host case", leftName: "A01", left: upperHost, rightName: "A01", right: lowerHost, wantSame: true},
		{name: "different name", leftName: "A01", left: base, rightName: "A02", right: base, wantSame: false},
		{name: "name case is significant", leftName: "A01", left: base, rightName: "a01", right: base, wantSame: false},
		{name: "different host", leftName: "A01", left: base, rightName: "A01", right: otherHost, wantSame: false},
		{name: "different port", leftName: "A01", left: base, rightName: "A01", right: otherPort, wantSame: false},
		{name: "different user", leftName: "A01", left: base, rightName: "A01", right: otherUser, wantSame: false},
		{name: "different database", leftName: "A01", left: base, rightName: "A01", right: otherDatabase, wantSame: false},
		{name: "same tunnel", leftName: "db", left: tunnel("jump-a"), rightName: "db", right: tunnel("jump-a"), wantSame: true},
		{name: "different jump host", leftName: "db", left: tunnel("jump-a"), rightName: "db", right: tunnel("jump-b"), wantSame: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			same := connectionImportIdentity(tt.leftName, tt.left) == connectionImportIdentity(tt.rightName, tt.right)
			if same != tt.wantSame {
				t.Fatalf("same = %v, want %v", same, tt.wantSame)
			}
		})
	}
}

func TestImportConnectionsExcelFileSkipsConnectionsThatAlreadyExist(t *testing.T) {
	app := newConnectionImportTestApp(t)
	lines := []string{"A", "B", "D", "E"}
	const machinesPerLine = 18
	total := len(lines) * machinesPerLine
	path := writeConnectionsExcelFixture(t, vulcanizerExcelRows(lines, machinesPerLine))

	first, err := app.importConnectionsExcelFile(path)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if len(first.Connections) != total || first.SkippedCount != 0 {
		t.Fatalf("first import = %d imported / %d skipped, want %d / 0", len(first.Connections), first.SkippedCount, total)
	}
	if len(first.ExcelGroups) != total {
		t.Fatalf("first import group assignments = %d, want %d", len(first.ExcelGroups), total)
	}

	second, err := app.importConnectionsExcelFile(path)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if len(second.Connections) != 0 || second.SkippedCount != total {
		t.Fatalf("second import = %d imported / %d skipped, want 0 / %d", len(second.Connections), second.SkippedCount, total)
	}
	if len(second.ExcelGroups) != 0 {
		t.Fatalf("skipped rows must not be regrouped, got %d assignments", len(second.ExcelGroups))
	}
	if got := mustSavedConnectionCount(t, app); got != total {
		t.Fatalf("saved connections after re-import = %d, want %d", got, total)
	}
}

func TestImportConnectionsExcelFileImportsOnlyRowsAddedSinceLastImport(t *testing.T) {
	app := newConnectionImportTestApp(t)
	if _, err := app.importConnectionsExcelFile(writeConnectionsExcelFixture(t, vulcanizerExcelRows([]string{"A"}, 18))); err != nil {
		t.Fatalf("first import: %v", err)
	}

	result, err := app.importConnectionsExcelFile(writeConnectionsExcelFixture(t, vulcanizerExcelRows([]string{"A", "C"}, 18)))
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if len(result.Connections) != 18 || result.SkippedCount != 18 {
		t.Fatalf("second import = %d imported / %d skipped, want 18 / 18", len(result.Connections), result.SkippedCount)
	}
	for _, view := range result.Connections {
		if view.Name[:1] != "C" {
			t.Fatalf("imported an existing connection again: %q", view.Name)
		}
	}
	if len(result.ExcelGroups) != 18 {
		t.Fatalf("group assignments = %d, want only the 18 new rows", len(result.ExcelGroups))
	}
	if got := mustSavedConnectionCount(t, app); got != 36 {
		t.Fatalf("saved connections = %d, want 36", got)
	}
}

func TestImportConnectionsExcelFileSkipsRowsRepeatedInsideTheFile(t *testing.T) {
	app := newConnectionImportTestApp(t)
	rows := vulcanizerExcelRows([]string{"A"}, 3)
	rows = append(rows, vulcanizerExcelRows([]string{"A"}, 3)...)
	// Same name on another address is a different machine and must survive.
	rows = append(rows, map[string]interface{}{"name": "A01", "type": "sqlserver", "host": "172.19.99.1", "port": "1433", "user": "sa"})

	result, err := app.importConnectionsExcelFile(writeConnectionsExcelFixture(t, rows))
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(result.Connections) != 4 || result.SkippedCount != 3 {
		t.Fatalf("import = %d imported / %d skipped, want 4 / 3", len(result.Connections), result.SkippedCount)
	}
}

func TestImportConnectionsExcelFileStillSkipsAfterConnectionWasEditedInTheForm(t *testing.T) {
	app := newConnectionImportTestApp(t)
	path := writeConnectionsExcelFixture(t, vulcanizerExcelRows([]string{"A"}, 2))
	first, err := app.importConnectionsExcelFile(path)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}

	// The edit form persists its own defaults and whatever the user changed
	// that does not alter which server the connection points at.
	edited := first.Connections[0]
	config := edited.Config
	config.Timeout = 30
	config.SSLMode = "preferred"
	config.Password = "rotated"
	if _, err := app.SaveConnection(connection.SavedConnectionInput{ID: edited.ID, Name: edited.Name, Config: config}); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}

	second, err := app.importConnectionsExcelFile(path)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if len(second.Connections) != 0 || second.SkippedCount != 2 {
		t.Fatalf("second import = %d imported / %d skipped, want 0 / 2", len(second.Connections), second.SkippedCount)
	}
	resolved, err := app.resolveConnectionSecrets(connection.ConnectionConfig{ID: edited.ID})
	if err != nil {
		t.Fatalf("resolveConnectionSecrets: %v", err)
	}
	if resolved.Password != "rotated" {
		t.Fatalf("re-import overwrote the locally changed password: %q", resolved.Password)
	}
}

func TestImportConnectionsExcelFileComparesDSNForDSNOnlyConnections(t *testing.T) {
	app := newConnectionImportTestApp(t)
	row := func(dsn string) map[string]interface{} {
		return map[string]interface{}{"name": "warehouse", "type": "custom", "dsn": dsn}
	}
	if _, err := app.importConnectionsExcelFile(writeConnectionsExcelFixture(t, []map[string]interface{}{row("dsn-east")})); err != nil {
		t.Fatalf("first import: %v", err)
	}

	result, err := app.importConnectionsExcelFile(writeConnectionsExcelFixture(t, []map[string]interface{}{
		row("dsn-east"), row("dsn-west"),
	}))
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if len(result.Connections) != 1 || result.SkippedCount != 1 {
		t.Fatalf("second import = %d imported / %d skipped, want 1 / 1", len(result.Connections), result.SkippedCount)
	}
	if got := mustSavedConnectionCount(t, app); got != 2 {
		t.Fatalf("saved connections = %d, want 2", got)
	}
}

func TestImportConnectionsPayloadSkipsLegacyJSONEntriesThatAlreadyExist(t *testing.T) {
	app := newConnectionImportTestApp(t)
	raw, err := json.Marshal([]connection.LegacySavedConnection{
		{Name: "orders", Config: connection.ConnectionConfig{Type: "mysql", Host: "10.0.0.8", Port: 3306, User: "root", Password: "secret"}},
		{Name: "billing", Config: connection.ConnectionConfig{Type: "postgres", Host: "10.0.0.9", Port: 5432, User: "postgres"}},
	})
	if err != nil {
		t.Fatalf("marshal legacy payload: %v", err)
	}

	first, err := app.ImportConnectionsPayload(string(raw), "")
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if len(first.Connections) != 2 || first.SkippedCount != 0 {
		t.Fatalf("first import = %d imported / %d skipped, want 2 / 0", len(first.Connections), first.SkippedCount)
	}
	second, err := app.ImportConnectionsPayload(string(raw), "")
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if len(second.Connections) != 0 || second.SkippedCount != 2 {
		t.Fatalf("second import = %d imported / %d skipped, want 0 / 2", len(second.Connections), second.SkippedCount)
	}
	if got := mustSavedConnectionCount(t, app); got != 2 {
		t.Fatalf("saved connections = %d, want 2", got)
	}
}

func TestImportConnectionPackagePayloadUpdatesByIDAndSkipsCopiesUnderNewIDs(t *testing.T) {
	app := newConnectionImportTestApp(t)
	item := func(id, name, host string) connectionPackageItem {
		return connectionPackageItem{
			ID:      id,
			Name:    name,
			Config:  connection.ConnectionConfig{ID: id, Type: "mysql", Host: host, Port: 3306, User: "root"},
			Secrets: connectionSecretBundle{Password: "secret"},
		}
	}
	if _, err := app.importConnectionPackagePayload(connectionPackagePayload{Connections: []connectionPackageItem{
		item("conn-1", "orders", "10.0.0.8"),
	}}); err != nil {
		t.Fatalf("seed import: %v", err)
	}

	report, err := app.importConnectionPackagePayload(connectionPackagePayload{Connections: []connectionPackageItem{
		item("conn-1", "orders", "10.0.0.80"),     // same ID: the package wins
		item("conn-other", "orders", "10.0.0.80"), // copy of the updated entry
		item("conn-stale", "orders", "10.0.0.8"),  // the address conn-1 just left
		item("conn-new", "billing", "10.0.0.9"),   // genuinely new
		item("conn-new-2", "billing", "10.0.0.9"), // repeated inside the package
	}})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(report.Views) != 3 || report.Skipped != 2 {
		t.Fatalf("import = %d written / %d skipped, want 3 / 2", len(report.Views), report.Skipped)
	}
	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections: %v", err)
	}
	hostByID := make(map[string]string, len(saved))
	for _, view := range saved {
		hostByID[view.ID] = view.Config.Host
	}
	want := map[string]string{"conn-1": "10.0.0.80", "conn-stale": "10.0.0.8", "conn-new": "10.0.0.9"}
	if len(hostByID) != len(want) {
		t.Fatalf("saved connections = %v, want %v", hostByID, want)
	}
	for id, host := range want {
		if hostByID[id] != host {
			t.Fatalf("saved connections = %v, want %v", hostByID, want)
		}
	}
}

// Cloud restore must reproduce the snapshot exactly, so the lower-level
// import keeps entries that only differ by ID.
func TestImportSavedConnectionsAtomicallyKeepsEntriesThatOnlyDifferByID(t *testing.T) {
	app := newConnectionImportTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "10.0.0.8", Port: 3306, User: "root"}
	views, err := app.importSavedConnectionsAtomically([]connection.SavedConnectionInput{
		{ID: "conn-a", Name: "orders", Config: config},
		{ID: "conn-b", Name: "orders", Config: config},
	})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(views) != 2 || mustSavedConnectionCount(t, app) != 2 {
		t.Fatalf("import wrote %d views, want 2", len(views))
	}
}
