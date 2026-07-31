//go:build gonavi_full_drivers || gonavi_iris_driver

package db

import (
	"strings"
	"testing"
	"GoNavi-Wails/shared/i18n"
)

var rawIRISTableNameRequiredText = string([]rune{0x8868, 0x540d, 0x4e0d, 0x80fd, 0x4e3a, 0x7a7a})

func TestIRISTableRefErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tests := []struct {
		name string
		raw  string
	}{
		{name: "empty table", raw: " "},
		{name: "empty qualified table", raw: `"APP". `},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseIRISTableRef("USER", tc.raw)
			if err == nil {
				t.Fatal("expected IRIS table reference parsing to fail")
			}
			if err.Error() != "Table name is required" {
				t.Fatalf("expected English table-name-required error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), rawIRISTableNameRequiredText) {
				t.Fatalf("expected no raw Chinese table-name-required text, got %q", err.Error())
			}
		})
	}
}


func TestIRISTableNameRequiredCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		if strings.TrimSpace(catalog["db.backend.error.table_name_required"]) == "" {
			t.Fatalf("%s catalog missing IRIS table-name-required key", language)
		}
	}
}
