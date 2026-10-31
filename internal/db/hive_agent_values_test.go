package db

import (
	"bufio"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func TestHiveAgentIntegerKeysWithBinaryBatch(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true,"data":[{"name":"mapping","type":"MAP<INT,STRING>"},{"name":"payload","type":"BINARY"}]}` + "\n")),
		driver: "hive",
	}
	database := &OptionalDriverAgentDB{driverType: "hive", client: client}
	mapping := map[int]string{1: "x", -2: "y"}
	original := connection.ChangeSet{Inserts: []map[string]any{{"mapping": mapping}, {"payload": []byte{0, 255}}}}
	got, err := hiveChangesForAgent(context.Background(), database, "db.tbl", original)
	if err != nil {
		t.Fatal(err)
	}
	if got.Inserts[1]["payload"] != "0x00ff" || original.Inserts[0]["mapping"].(map[int]string)[1] != "x" {
		t.Fatalf("batch changed binary or input: %#v", got)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var restored connection.ChangeSet
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	literal, err := hivesql.Value("MAP<INT,STRING>", restored.Inserts[0]["mapping"])
	if err != nil || !strings.Contains(literal, "CAST(1 AS INT), 'x'") || !strings.Contains(literal, "CAST(-2 AS INT), 'y'") {
		t.Fatalf("IPC integer key semantics lost: %q, %v", literal, err)
	}
}
