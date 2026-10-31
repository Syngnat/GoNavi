package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

// TestHiveLiveAgentStreamBridge uses a final operator-supplied Hive agent, not
// handwritten host frames. Its constant SELECTs create no MapReduce workload.
// Run without gonavi_hive_driver so the public factory exercises the UI proxy.
func TestHiveLiveAgentStreamBridge(t *testing.T) {
	path := strings.TrimSpace(os.Getenv("GONAVI_HIVE_LIVE_AGENT_PATH"))
	if path == "" {
		t.Skip("GONAVI_HIVE_LIVE_AGENT_PATH is not configured")
	}
	config := hiveSyncEnvironmentConfig(t)
	installHiveAgentPrivateFixture(t, path)
	database, err := db.NewDatabase("hive")
	if err != nil {
		t.Fatal(err)
	}
	if _, proxy := database.(*db.OptionalDriverAgentDB); !proxy {
		t.Fatal("agent bridge must run without native Hive build tags")
	}
	if err := database.Connect(config); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Errorf("close Hive agent: %v", err)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, test := range []struct {
		name, query string
		rows        int
	}{
		{"typed row", "SELECT 1 AS id, 'bridge' AS note", 1},
		{"typed empty result", "SELECT 1 AS id, 'bridge' AS note WHERE 1 = 0", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			definitionsSeen := 0
			var rows []map[string]interface{}
			columns, err := streamHiveSourceQueryRows(ctx, SyncConfig{SourceConfig: config, SourceQuery: test.query}, database, 2, func(batch []map[string]interface{}) error { rows = append(rows, batch...); return nil }, func(columns []connection.ColumnDefinition) error {
				definitionsSeen++
				if len(columns) != 2 || !strings.EqualFold(columns[0].Name, "id") || !strings.EqualFold(columns[1].Name, "note") {
					return fmt.Errorf("agent column definitions are incomplete: %+v", columns)
				}
				for _, column := range columns {
					if _, err := hivesql.ParseType(column.Type); err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				t.Fatalf("actual agent -> Hive sync consumer bridge: %v", err)
			}
			if definitionsSeen != 1 || len(columns) != 2 || len(rows) != test.rows {
				t.Fatalf("bridge metadata/rows = definitions:%d columns:%v rows:%v", definitionsSeen, columns, rows)
			}
			if len(rows) == 1 && (fmt.Sprint(rows[0]["id"]) != "1" || rows[0]["note"] != "bridge") {
				t.Fatalf("agent labels/value lost: %#v", rows[0])
			}
		})
	}
}

func installHiveAgentPrivateFixture(t *testing.T, sourcePath string) {
	t.Helper()
	oldRoot, err := db.ResolveExternalDriverRoot("")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	db.SetExternalDriverDownloadDirectory(root)
	t.Cleanup(func() { db.SetExternalDriverDownloadDirectory(oldRoot) })
	path, err := db.ResolveOptionalDriverAgentExecutablePath(root, "hive")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(sourcePath)
	if err != nil || len(payload) == 0 {
		t.Fatalf("read final Hive agent: bytes=%d err=%v", len(payload), err)
	}
	if err := os.WriteFile(path, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	marker, err := db.ResolveOptionalGoDriverMarkerPath(root, "hive")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(db.OptionalDriverAgentMetadata{DriverType: "hive", AgentRevision: db.OptionalDriverAgentRevision("hive"), ProtocolSchema: db.OptionalDriverAgentProtocolSchemaV2})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}
