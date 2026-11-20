package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/webidentity"
)

func writeScriptInputWorkbook(t *testing.T, sheetNames []string) string {
	t.Helper()
	var workbook strings.Builder
	workbook.WriteString(`<workbook xmlns="`)
	workbook.WriteString(xlsxMainNamespace)
	workbook.WriteString(`" xmlns:r="`)
	workbook.WriteString(xlsxRelationshipsNamespace)
	workbook.WriteString(`"><sheets>`)
	for index, name := range sheetNames {
		var escaped bytes.Buffer
		if err := xml.EscapeText(&escaped, []byte(name)); err != nil {
			t.Fatalf("escape worksheet name %q: %v", name, err)
		}
		workbook.WriteString(`<sheet name="`)
		workbook.WriteString(escaped.String())
		workbook.WriteString(`" sheetId="`)
		workbook.WriteString(strconv.Itoa(index + 1))
		workbook.WriteString(`" r:id="rId`)
		workbook.WriteString(strconv.Itoa(index + 1))
		workbook.WriteString(`"/>`)
	}
	workbook.WriteString(`</sheets></workbook>`)
	return writeXLSXTestArchive(t, map[string]xlsxTestEntry{
		xlsxWorkbookXMLPath: {body: workbook.String(), method: zip.Store},
	})
}

func requireScriptInputSheets(t *testing.T, result connection.QueryResult) []string {
	t.Helper()
	if !result.Success {
		t.Fatalf("list worksheets failed: %s", result.Message)
	}
	data, ok := result.Data.(map[string]any)
	if !ok {
		t.Fatalf("result data type = %T, want map[string]any", result.Data)
	}
	sheets, ok := data["sheets"].([]string)
	if !ok {
		t.Fatalf("sheets type = %T, want []string", data["sheets"])
	}
	return sheets
}

func TestListScriptInputSheetsPreservesWorkbookOrder(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	path := writeScriptInputWorkbook(t, []string{"Summary", "明细", "Archive"})

	result := application.ListScriptInputSheets(ScriptWorkbenchInput{
		Alias:     "ignored-alias",
		Path:      path,
		Name:      "ignored-name.json",
		SheetName: "ignored-sheet",
		Encoding:  "gbk",
		Delimiter: "|",
	})
	sheets := requireScriptInputSheets(t, result)
	want := []string{"Summary", "明细", "Archive"}
	if !slices.Equal(sheets, want) {
		t.Fatalf("sheet names = %v, want %v", sheets, want)
	}
}

func TestListScriptInputSheetsSkipsNonWorksheetRelationships(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	workbook := `<workbook xmlns="` + xlsxMainNamespace +
		`" xmlns:r="` + xlsxRelationshipsNamespace +
		`"><sheets>` +
		`<sheet name="Data" sheetId="1" r:id="rId1"/>` +
		`<sheet name="Chart" sheetId="2" r:id="rId2"/>` +
		`<sheet name="More" sheetId="3" r:id="rId3"/>` +
		`</sheets></workbook>`
	rels := `<Relationships xmlns="` + xlsxRelationshipsNamespace + `">` +
		`<Relationship Id="rId1" Type="` + xlsxRelationshipsNamespace + `/worksheet" Target="worksheets/sheet1.xml"/>` +
		`<Relationship Id="rId2" Type="` + xlsxRelationshipsNamespace + `/chartsheet" Target="chartsheets/sheet1.xml"/>` +
		`<Relationship Id="rId3" Type="` + xlsxRelationshipsNamespace + `/worksheet" Target="worksheets/sheet2.xml"/>` +
		`</Relationships>`
	path := writeXLSXTestArchive(t, map[string]xlsxTestEntry{
		xlsxWorkbookXMLPath:     {body: workbook, method: zip.Store},
		xlsxWorkbookRelsXMLPath: {body: rels, method: zip.Store},
	})

	sheets := requireScriptInputSheets(t, application.ListScriptInputSheets(
		ScriptWorkbenchInput{Path: path},
	))
	if want := []string{"Data", "More"}; !slices.Equal(sheets, want) {
		t.Fatalf("sheet names = %v, want %v", sheets, want)
	}
}

func TestListScriptInputSheetsReturnsEmptyArrayForTextInputs(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	for _, extension := range []string{".csv", ".json"} {
		t.Run(extension, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "input"+extension)
			if err := os.WriteFile(path, []byte("not parsed by this method"), 0o600); err != nil {
				t.Fatalf("write input: %v", err)
			}
			sheets := requireScriptInputSheets(t, application.ListScriptInputSheets(
				ScriptWorkbenchInput{Path: path},
			))
			if sheets == nil {
				t.Fatal("text input sheets must be an empty array, not null")
			}
			if len(sheets) != 0 {
				t.Fatalf("text input sheets = %v, want empty", sheets)
			}
		})
	}
}

func TestListScriptInputSheetsRejectsUnsupportedFiles(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	tests := []struct {
		name        string
		extension   string
		messagePart string
	}{
		{name: "legacy xls", extension: ".xls", messagePart: "legacy .xls"},
		{name: "unknown format", extension: ".txt", messagePart: "not supported"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "input"+testCase.extension)
			if err := os.WriteFile(path, []byte("fixture"), 0o600); err != nil {
				t.Fatalf("write input: %v", err)
			}
			result := application.ListScriptInputSheets(ScriptWorkbenchInput{Path: path})
			if result.Success {
				t.Fatalf("unsupported input %s unexpectedly succeeded", testCase.extension)
			}
			if !strings.Contains(result.Message, testCase.messagePart) {
				t.Fatalf("message = %q, want part %q", result.Message, testCase.messagePart)
			}
		})
	}
}

func TestListScriptInputSheetsRejectsMissingFile(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	result := application.ListScriptInputSheets(ScriptWorkbenchInput{
		Path: filepath.Join(t.TempDir(), "missing.xlsx"),
	})
	if result.Success {
		t.Fatal("missing input unexpectedly succeeded")
	}
	if !strings.Contains(result.Message, "script input file is unavailable") {
		t.Fatalf("message = %q, want readable unavailable error", result.Message)
	}
}

func TestListScriptInputSheetsDoesNotLeakArchivePath(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	root := t.TempDir()
	path := filepath.Join(root, "invalid.xlsx")
	if err := os.WriteFile(path, []byte("not a zip archive"), 0o600); err != nil {
		t.Fatalf("write invalid archive: %v", err)
	}
	result := application.ListScriptInputSheets(ScriptWorkbenchInput{Path: path})
	if result.Success {
		t.Fatal("invalid XLSX archive unexpectedly succeeded")
	}
	if strings.Contains(result.Message, root) || strings.Contains(result.Message, path) {
		t.Fatalf("archive error leaked a user path: %q", result.Message)
	}
}

func TestListScriptInputSheetsWebRejectsOtherOwners(t *testing.T) {
	path := writeScriptInputWorkbook(t, []string{"First", "Second"})
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	application := newScriptWorkbenchTestApp(t, true)
	upload, err := StageWebUploadForEntryPointForOwner(
		application,
		webUploadPurposeScriptInput,
		"input.xlsx",
		bytes.NewReader(payload),
		"alice",
	)
	if err != nil {
		t.Fatalf("stage script input: %v", err)
	}
	handlerValue := WebRPCContextHandlers(application)["ListScriptInputSheets"]
	handler, ok := handlerValue.(func(context.Context, ScriptWorkbenchInput) connection.QueryResult)
	if !ok {
		t.Fatal("ListScriptInputSheets context handler has an unexpected signature")
	}
	input := ScriptWorkbenchInput{Reference: upload.FilePath}
	aliceCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	aliceResult := handler(aliceCtx, input)
	if !aliceResult.Success {
		t.Fatalf("owner worksheet lookup failed: %s", aliceResult.Message)
	}
	if sheets := requireScriptInputSheets(t, aliceResult); !slices.Equal(sheets, []string{"First", "Second"}) {
		t.Fatalf("owner sheet names = %v", sheets)
	}

	bobCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "bob",
		Role:     webidentity.RoleAdmin,
	})
	bobResult := handler(bobCtx, input)
	if bobResult.Success {
		t.Fatal("cross-user worksheet lookup unexpectedly succeeded")
	}
	if strings.Contains(bobResult.Message, application.configDir) {
		t.Fatalf("cross-user error leaked the transfer root: %q", bobResult.Message)
	}

	anonymousResult := handler(context.Background(), input)
	if anonymousResult.Success {
		t.Fatal("anonymous worksheet lookup unexpectedly succeeded")
	}
}

func TestReadXLSXSheetNamesEnforcesMetadataLimits(t *testing.T) {
	tooMany := make([]string, maxXLSXSheetCount+1)
	for index := range tooMany {
		tooMany[index] = "Sheet" + strings.Repeat("x", index%8)
	}
	tests := []struct {
		name   string
		sheets []string
	}{
		{name: "empty name", sheets: []string{""}},
		{name: "long name", sheets: []string{strings.Repeat("s", maxXLSXSheetNameBytes+1)}},
		{name: "too many sheets", sheets: tooMany},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			path := writeScriptInputWorkbook(t, testCase.sheets)
			if _, err := readXLSXSheetNames(path); err == nil {
				t.Fatal("oversized workbook metadata unexpectedly succeeded")
			}
		})
	}
}
