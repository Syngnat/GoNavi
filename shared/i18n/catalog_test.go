package i18n

import (
	"archive/zip"
	"bytes"
	"os"
	"testing"
)

func TestResolveLanguagePreference(t *testing.T) {
	tests := []struct {
		name       string
		preference string
		system     []string
		want       Language
	}{
		{name: "explicit Chinese wins", preference: "zh-CN", system: []string{"en-US"}, want: LanguageZhCN},
		{name: "explicit Traditional Chinese wins", preference: "zh-TW", system: []string{"en-US"}, want: LanguageZhTW},
		{name: "explicit English wins", preference: "en-US", system: []string{"zh-CN"}, want: LanguageEnUS},
		{name: "explicit Japanese wins", preference: "ja-JP", system: []string{"en-US"}, want: LanguageJaJP},
		{name: "explicit German wins", preference: "de-DE", system: []string{"en-US"}, want: LanguageDeDE},
		{name: "explicit Russian wins", preference: "ru-RU", system: []string{"en-US"}, want: LanguageRuRU},
		{name: "system Chinese region maps to simplified Chinese", preference: "system", system: []string{"zh-SG"}, want: LanguageZhCN},
		{name: "system Traditional Chinese Hong Kong maps to Traditional Chinese", preference: "system", system: []string{"zh-HK"}, want: LanguageZhTW},
		{name: "system English region maps to US English", preference: "system", system: []string{"en-IN"}, want: LanguageEnUS},
		{name: "system Japanese maps to Japanese", preference: "system", system: []string{"ja"}, want: LanguageJaJP},
		{name: "system German maps to German", preference: "system", system: []string{"de-DE"}, want: LanguageDeDE},
		{name: "system Russian maps to Russian", preference: "system", system: []string{"ru-RU"}, want: LanguageRuRU},
		{name: "unsupported system falls back to English", preference: "system", system: []string{"fr-FR"}, want: LanguageEnUS},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ResolveLanguage(tt.preference, tt.system); got != tt.want {
				t.Fatalf("ResolveLanguage(%q, %#v)=%q, want %q", tt.preference, tt.system, got, tt.want)
			}
		})
	}
}

func TestCatalogKeysMatch(t *testing.T) {
	catalogs, err := LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	languages := SupportedLanguages()
	if len(languages) != 6 {
		t.Fatalf("SupportedLanguages() length=%d, want 6", len(languages))
	}

	base := catalogs[LanguageEnUS]
	if len(base) == 0 {
		t.Fatal("expected non-empty en-US catalog")
	}

	for _, language := range languages {
		catalog := catalogs[language]
		if len(catalog) == 0 {
			t.Fatalf("expected non-empty %s catalog", language)
		}
		for key := range base {
			if _, ok := catalog[key]; !ok {
				t.Fatalf("%s catalog missing key %q", language, key)
			}
		}
		for key := range catalog {
			if _, ok := base[key]; !ok {
				t.Fatalf("%s catalog has extra key %q", language, key)
			}
		}
	}
}

func TestLocalizerFormatsParametersAndFallsBack(t *testing.T) {
	localizer, err := NewLocalizer(LanguageEnUS)
	if err != nil {
		t.Fatalf("NewLocalizer() error = %v", err)
	}

	if got := localizer.T("common.named_item", map[string]any{"name": "orders"}); got != "orders" {
		t.Fatalf("named item translation = %q, want orders", got)
	}
	if got := localizer.T("common.named_item", map[string]any{"name": "  raw value \n"}); got != "  raw value \n" {
		t.Fatalf("localized parameter text = %q, want exact raw parameter", got)
	}
	if got := localizer.T("missing.key", nil); got != "missing.key" {
		t.Fatalf("missing translation = %q, want key fallback", got)
	}
}

// TestCatalogZipInSyncWithJSON 校验嵌入的 catalog.zip 与磁盘上的语言 JSON
// 逐字节一致:改了 JSON 忘了 `go generate ./shared/i18n` 时在这里拦下。
func TestCatalogZipInSyncWithJSON(t *testing.T) {
	zipPayload, err := catalogZipFS.ReadFile("catalog.zip")
	if err != nil {
		t.Fatalf("读取 catalog.zip 失败: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(zipPayload), int64(len(zipPayload)))
	if err != nil {
		t.Fatalf("解析 catalog.zip 失败: %v", err)
	}

	entries := make(map[string][]byte, len(supportedLanguageOrder))
	for _, file := range reader.File {
		payload, err := readFileFromZip(file)
		if err != nil {
			t.Fatalf("读取 zip 条目 %s 失败: %v", file.Name, err)
		}
		entries[file.Name] = payload
	}
	if len(entries) != len(supportedLanguageOrder) {
		t.Fatalf("catalog.zip 应只含 %d 个语言文件,实际 %d 个", len(supportedLanguageOrder), len(entries))
	}

	for _, lang := range supportedLanguageOrder {
		name := string(lang) + ".json"
		disk, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("读取 %s 失败: %v", name, err)
		}
		zipped, ok := entries[name]
		if !ok {
			t.Fatalf("catalog.zip 缺少 %s", name)
		}
		if !bytes.Equal(disk, zipped) {
			t.Errorf("%s 与 catalog.zip 内容不一致,请执行 go generate ./shared/i18n 重新生成", name)
		}
	}
}

func readFileFromZip(file *zip.File) ([]byte, error) {
	rc, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(rc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
