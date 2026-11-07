package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	runtime "GoNavi-Wails/internal/desktop"
)

func TestPluginExportNativeSnapshotGoldenAndDeepFreeze(t *testing.T) {
	fixture := newNativePluginExportFixture(t, false)
	destination := filepath.Join(t.TempDir(), "report.ndjson")
	if err := os.WriteFile(destination, []byte("OLD"), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := map[string]any{"precise": json.Number("12345678901234567890")}
	rows := []map[string]any{{"secret": "UNSELECTED-MUST-NOT-LEAK", "big": json.Number("9007199254740993"), "binary": []byte{0, 255}, "null": nil, "nested": nested, "text": "before"}}
	options := fixture.options()
	options.Columns = []string{"big", "binary", "missing", "null", "nested", "text"}
	fixture.app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		rows[0]["text"] = "after"
		nested["precise"] = "changed"
		return destination, nil
	}
	result := fixture.app.ExportDataWithOptions(rows, []string{"secret", "big", "binary", "missing", "null", "nested", "text"}, "snapshot", options)
	if !result.Success {
		t.Fatalf("native snapshot export: %+v", result)
	}
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"big":{"kind":"number","value":9007199254740993},"binary":{"kind":"binary","value":"AP8="},"missing":{"kind":"missing"},"null":{"kind":"null"},"nested":{"kind":"json","value":{"precise":12345678901234567890}},"text":{"kind":"string","value":"before"}}` + "\n"
	if string(content) != expected {
		t.Fatalf("snapshot output differs from exact tagged golden: %q", content)
	}
	assertNoTempExportResidue(t, filepath.Dir(destination))
}

func TestPluginExportNativePickerInvalidationPreservesDestination(t *testing.T) {
	fixture := newNativePluginExportFixture(t, false)
	destination := filepath.Join(t.TempDir(), "report.ndjson")
	root := fixture.app.configDir
	for _, scenario := range []string{"picker_cancel", "job_cancel", "root_change", "disable"} {
		t.Run(scenario, func(t *testing.T) {
			if err := os.WriteFile(destination, []byte("OLD"), 0o600); err != nil {
				t.Fatal(err)
			}
			options := fixture.options()
			options.JobID = "export-" + scenario
			fixture.app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
				switch scenario {
				case "picker_cancel":
					return "", nil
				case "job_cancel":
					if err := fixture.app.requestExportTaskCancellation(options.JobID); err != nil {
						t.Fatal(err)
					}
				case "root_change":
					fixture.app.configDir = t.TempDir()
				case "disable":
					if _, err := fixture.manager.SetEnabled(fixture.ctx, "sdk.examples.ndjson", false); err != nil {
						t.Fatal(err)
					}
				}
				return destination, nil
			}
			result := fixture.app.ExportDataWithOptions([]map[string]any{{"v": "new"}}, []string{"v"}, "snapshot", options)
			fixture.app.configDir = root
			if result.Success {
				t.Fatal("invalidated export committed")
			}
			content, err := os.ReadFile(destination)
			if err != nil || string(content) != "OLD" {
				t.Fatal("precommit invalidation altered existing target")
			}
			assertNoTempExportResidue(t, filepath.Dir(destination))
		})
	}
}

func TestPluginExportNativeRejectsProtectedAndSuffixCollisionTargets(t *testing.T) {
	fixture := newNativePluginExportFixture(t, false)
	ordinary := filepath.Join(t.TempDir(), "report")
	if err := os.WriteFile(ordinary+".ndjson", []byte("OLD"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, selected := range []string{filepath.Join(fixture.root, "protected.ndjson"), ordinary} {
		fixture.app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) { return selected, nil }
		result := fixture.app.ExportDataWithOptions([]map[string]any{{"v": "new"}}, []string{"v"}, "snapshot", fixture.options())
		if result.Success {
			t.Fatal("protected or silently suffixed collision target accepted")
		}
	}
	content, err := os.ReadFile(ordinary + ".ndjson")
	if err != nil || string(content) != "OLD" {
		t.Fatal("suffix collision overwrote existing target")
	}
	if _, err := os.Stat(filepath.Join(fixture.root, "protected.ndjson")); !os.IsNotExist(err) {
		t.Fatal("protected target was created")
	}
}

func TestPluginExportNativeStreamingBeyondOneShotRowCap(t *testing.T) {
	fixture := newNativePluginExportFixture(t, false)
	destination := filepath.Join(t.TempDir(), "large.ndjson")
	rows := make([]map[string]any, 5000)
	for index := range rows {
		rows[index] = map[string]any{"id": index, "text": "value"}
	}
	options := fixture.options()
	options.Columns = []string{"id", "text"}
	fixture.app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return destination, nil
	}
	result := fixture.app.ExportDataWithOptions(rows, []string{"id", "text"}, "stream", options)
	if !result.Success {
		t.Fatalf("streaming native export: %+v", result)
	}
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Count(string(content), "\n"); lines != 5000 {
		t.Fatalf("streamed row count: %d", lines)
	}
	if !strings.Contains(string(content), `"id":{"kind":"number","value":4999}`) {
		t.Fatal("last row missing from streamed document")
	}
	assertNoTempExportResidue(t, filepath.Dir(destination))
}
