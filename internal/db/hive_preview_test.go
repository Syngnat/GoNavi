//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHivePreviewMatchesExecutedTypedStatements(t *testing.T) {
	service := newHiveFakeService()
	service.columnRows = [][]any{{"id", "bigint", ""}, {"tags", "array<string>", ""}, {"payload", "binary", ""}, {"part", "string", ""}, {"# Partition Information", "", nil}, {"part", "string", ""}}
	config := hiveFakeBinary(t, service, true)
	driver := &HiveDB{}
	if err := driver.Connect(config); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	changes := connection.ChangeSet{
		Deletes: []map[string]any{{"id": json.Number("9223372036854775807")}},
		Updates: []connection.UpdateRow{{Keys: map[string]any{"id": json.Number("2")}, Values: map[string]any{"payload": []byte{0, 255}}}},
		Inserts: []map[string]any{{"id": json.Number("3"), "tags": "[\"x\"]", "payload": []byte{0, 255}, "part": "p"}},
	}
	deletes, updates, inserts, ok := driver.TryPreviewChanges("default.base", changes)
	if !ok || len(deletes) != 1 || len(updates) != 1 || len(inserts) != 1 {
		t.Fatalf("typed preview=%v/%v/%v supported=%v", deletes, updates, inserts, ok)
	}
	if !strings.Contains(inserts[0], "INSERT INTO TABLE") || !strings.Contains(inserts[0], "PARTITION") || strings.Contains(inserts[0], " VALUES ") || !strings.Contains(inserts[0], "unhex('00ff')") {
		t.Fatalf("wrong Hive insert preview=%s", inserts[0])
	}
	if actual := hiveFakeMutationStatements(service); len(actual) != 0 {
		t.Fatalf("preview performed writes: %v", actual)
	}
	if err := driver.ApplyChangesContext(context.Background(), "default.base", changes); err != nil {
		t.Fatal(err)
	}
	preview := append(append(append([]string(nil), deletes...), updates...), inserts...)
	if actual := hiveFakeMutationStatements(service); !slices.Equal(preview, actual) {
		t.Fatalf("preview/execution differ preview=%v actual=%v", preview, actual)
	}
	changes.Inserts[0]["id"] = "not an integer"
	deletes, _, _, ok = driver.TryPreviewChanges("default.base", changes)
	if !ok || len(deletes) != 1 || !strings.HasPrefix(deletes[0], "-- Hive change preview unavailable:") {
		t.Fatalf("invalid preview must not fall back: %v supported=%v", deletes, ok)
	}
}

func hiveFakeMutationStatements(service *hiveFakeService) []string {
	service.mu.Lock()
	defer service.mu.Unlock()
	var mutations []string
	for _, statement := range service.statements {
		if strings.HasPrefix(statement, "DELETE FROM ") || strings.HasPrefix(statement, "UPDATE ") || strings.HasPrefix(statement, "INSERT INTO ") {
			mutations = append(mutations, statement)
		}
	}
	return mutations
}

func TestHivePreviewFailureCannotGenerateGenericSQL(t *testing.T) {
	driver := &HiveDB{}
	changes := connection.ChangeSet{Inserts: []map[string]any{{"id": 1}}}
	deletes, updates, inserts, ok := driver.TryPreviewChanges("table", changes)
	if !ok || len(deletes) != 1 || len(updates) != 0 || len(inserts) != 0 || !strings.HasPrefix(deletes[0], "-- ") {
		t.Fatalf("unavailable preview=%v/%v/%v supported=%v", deletes, updates, inserts, ok)
	}
}
