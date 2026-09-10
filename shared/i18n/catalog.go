package i18n

import (
	"archive/zip"
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
)

type Language string

const (
	LanguageZhCN Language = "zh-CN"
	LanguageZhTW Language = "zh-TW"
	LanguageEnUS Language = "en-US"
	LanguageJaJP Language = "ja-JP"
	LanguageDeDE Language = "de-DE"
	LanguageRuRU Language = "ru-RU"
)

const PreferenceSystem = "system"

var supportedLanguages = map[Language]struct{}{
	LanguageZhCN: {},
	LanguageZhTW: {},
	LanguageEnUS: {},
	LanguageJaJP: {},
	LanguageDeDE: {},
	LanguageRuRU: {},
}

var supportedLanguageOrder = []Language{
	LanguageZhCN,
	LanguageZhTW,
	LanguageEnUS,
	LanguageJaJP,
	LanguageDeDE,
	LanguageRuRU,
}

// catalog.zip 由 `go generate ./shared/i18n` 通过 tools/gen-i18n-catalog-zip
// 生成,内容是六个语言 JSON 的 deflate 打包:JSON 源文件是前端共享的,保持
// 明文入库,而 Go 侧以压缩形态嵌入,避免 6MB+ 的目录文本直接撑大二进制。
//
//go:generate go run ../../tools/gen-i18n-catalog-zip -dir .
//
//go:embed catalog.zip
var catalogZipFS embed.FS

type Catalog map[string]string

func NormalizeLanguage(value string) (Language, bool) {
	normalized := strings.TrimSpace(strings.ReplaceAll(value, "_", "-"))
	if normalized == "" {
		return "", false
	}
	lower := strings.ToLower(normalized)
	switch {
	case lower == "zh-tw" || lower == "zh-hk" || lower == "zh-mo":
		return LanguageZhTW, true
	case lower == "zh-cn" || lower == "zh-sg" || lower == "zh":
		return LanguageZhCN, true
	case lower == "en-us" || strings.HasPrefix(lower, "en-"):
		return LanguageEnUS, true
	case lower == "ja" || strings.HasPrefix(lower, "ja-"):
		return LanguageJaJP, true
	case lower == "de" || strings.HasPrefix(lower, "de-"):
		return LanguageDeDE, true
	case lower == "ru" || strings.HasPrefix(lower, "ru-"):
		return LanguageRuRU, true
	default:
		lang := Language(normalized)
		_, ok := supportedLanguages[lang]
		return lang, ok
	}
}

func ResolveLanguage(preference string, systemLanguages []string) Language {
	if lang, ok := NormalizeLanguage(preference); ok {
		return lang
	}
	for _, systemLanguage := range systemLanguages {
		if lang, ok := NormalizeLanguage(systemLanguage); ok {
			return lang
		}
	}
	return LanguageEnUS
}

func SupportedLanguages() []Language {
	languages := make([]Language, len(supportedLanguageOrder))
	copy(languages, supportedLanguageOrder)
	return languages
}

var (
	catalogZipOnce sync.Once
	catalogZip     *zip.Reader
	catalogZipErr  error
)

func loadCatalogZip() (*zip.Reader, error) {
	catalogZipOnce.Do(func() {
		payload, err := catalogZipFS.ReadFile("catalog.zip")
		if err != nil {
			catalogZipErr = err
			return
		}
		catalogZip, catalogZipErr = zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	})
	return catalogZip, catalogZipErr
}

func LoadCatalogs() (map[Language]Catalog, error) {
	zipReader, err := loadCatalogZip()
	if err != nil {
		return nil, fmt.Errorf("读取内置语言目录失败: %w", err)
	}
	result := make(map[Language]Catalog, len(supportedLanguageOrder))
	for _, lang := range supportedLanguageOrder {
		entry, err := zipReader.Open(string(lang) + ".json")
		if err != nil {
			return nil, fmt.Errorf("语言目录缺少 %s: %w", lang, err)
		}
		payload, err := io.ReadAll(entry)
		entry.Close()
		if err != nil {
			return nil, fmt.Errorf("读取语言目录 %s 失败: %w", lang, err)
		}
		var catalog Catalog
		if err := json.Unmarshal(payload, &catalog); err != nil {
			return nil, fmt.Errorf("解析语言目录 %s 失败: %w", lang, err)
		}
		result[lang] = catalog
	}
	return result, nil
}

type Localizer struct {
	language Language
	catalogs map[Language]Catalog
}

func NewLocalizer(language Language) (*Localizer, error) {
	catalogs, err := LoadCatalogs()
	if err != nil {
		return nil, err
	}
	if _, ok := supportedLanguages[language]; !ok {
		language = LanguageEnUS
	}
	return &Localizer{language: language, catalogs: catalogs}, nil
}

func (l *Localizer) SetLanguage(language Language) {
	if _, ok := supportedLanguages[language]; ok {
		l.language = language
	}
}

func (l *Localizer) Language() Language {
	if l == nil {
		return LanguageEnUS
	}
	return l.language
}

func (l *Localizer) T(key string, params map[string]any) string {
	if l == nil {
		return key
	}
	template := ""
	if catalog, ok := l.catalogs[l.language]; ok {
		template = catalog[key]
	}
	if template == "" && l.language != LanguageEnUS {
		template = l.catalogs[LanguageEnUS][key]
	}
	if template == "" {
		return key
	}
	for name, value := range params {
		template = strings.ReplaceAll(template, "{{"+name+"}}", toString(value))
	}
	return template
}

func toString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprint(typed)
	}
}
