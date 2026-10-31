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

// catalogCache 是全局按语言的目录缓存：Language -> Catalog。
// 历史上每个 Localizer 都各自解析整套六语言 JSON（单套 10MB 级），同一个
// 进程里 App、Web 认证页、各后端模块并存时会驻留两三份相同数据。现在解析
// 结果全局共享，且按语言惰性解析——只有真正被用到的语言才占内存。
// 条目解析后视为只读，调用方不得修改返回的 Catalog。
var catalogCache sync.Map

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

// LoadCatalog 返回单个语言的目录，首次访问时才解析，重复调用共享同一份
// 只读 map。单语言取用请走本函数，避免为一条翻译把六种语言全量驻留。
func LoadCatalog(language Language) (Catalog, error) {
	if cached, ok := catalogCache.Load(language); ok {
		return cached.(Catalog), nil
	}
	zipReader, err := loadCatalogZip()
	if err != nil {
		return nil, fmt.Errorf("读取内置语言目录失败: %w", err)
	}
	entry, err := zipReader.Open(string(language) + ".json")
	if err != nil {
		return nil, fmt.Errorf("语言目录缺少 %s: %w", language, err)
	}
	payload, err := io.ReadAll(entry)
	entry.Close()
	if err != nil {
		return nil, fmt.Errorf("读取语言目录 %s 失败: %w", language, err)
	}
	var catalog Catalog
	if err := json.Unmarshal(payload, &catalog); err != nil {
		return nil, fmt.Errorf("解析语言目录 %s 失败: %w", language, err)
	}
	actual, _ := catalogCache.LoadOrStore(language, catalog)
	return actual.(Catalog), nil
}

// LoadCatalogs 返回全部支持语言的目录。内部共享 LoadCatalog 的缓存，仅在
// 需要跨全语言聚合的场景使用（如连接 Excel 表头的多语言别名匹配）。
func LoadCatalogs() (map[Language]Catalog, error) {
	result := make(map[Language]Catalog, len(supportedLanguageOrder))
	for _, lang := range supportedLanguageOrder {
		catalog, err := LoadCatalog(lang)
		if err != nil {
			return nil, err
		}
		result[lang] = catalog
	}
	return result, nil
}

// Localizer 是单语言的翻译器，本身不持有目录数据：翻译时按语言从全局缓存
// 取用（见 catalogCache），因此任意数量的 Localizer 不会放大目录内存。
type Localizer struct {
	language Language
}

// NewLocalizer 创建指定语言的翻译器。构造时预载目标语言与英文回退目录，
// 让嵌入目录损坏在构造期暴露为错误，而不是第一次翻译时静默退化为裸 key。
func NewLocalizer(language Language) (*Localizer, error) {
	lang := language
	if _, ok := supportedLanguages[lang]; !ok {
		lang = LanguageEnUS
	}
	if _, err := LoadCatalog(lang); err != nil {
		return nil, err
	}
	if lang != LanguageEnUS {
		if _, err := LoadCatalog(LanguageEnUS); err != nil {
			return nil, err
		}
	}
	return &Localizer{language: lang}, nil
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

// T 翻译 key：先取当前语言，缺 key 回退英文。当前语言的目录尚未加载时
// （如 SetLanguage 切到新语言后的首次调用）会按语言惰性解析一次。
func (l *Localizer) T(key string, params map[string]any) string {
	if l == nil {
		return key
	}
	template := lookupTemplate(l.language, key)
	if template == "" && l.language != LanguageEnUS {
		template = lookupTemplate(LanguageEnUS, key)
	}
	if template == "" {
		return key
	}
	for name, value := range params {
		template = strings.ReplaceAll(template, "{{"+name+"}}", toString(value))
	}
	return template
}

func lookupTemplate(language Language, key string) string {
	cached, ok := catalogCache.Load(language)
	if !ok {
		loaded, err := LoadCatalog(language)
		if err != nil {
			return ""
		}
		cached = loaded
	}
	return cached.(Catalog)[key]
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
