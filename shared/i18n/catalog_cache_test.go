package i18n

import (
	"reflect"
	"strings"
	"testing"
)

// commonSuccessKey 是六个语言目录都存在的稳定 key（后端 ReclaimMemory 等
// 路径在用），适合作为跨语言断言样本。
const commonSuccessKey = "common.success"

func TestLoadCatalogSharesParsedCatalog(t *testing.T) {
	first, err := LoadCatalog(LanguageEnUS)
	if err != nil {
		t.Fatalf("LoadCatalog(en-US) error = %v", err)
	}
	second, err := LoadCatalog(LanguageEnUS)
	if err != nil {
		t.Fatalf("LoadCatalog(en-US) second call error = %v", err)
	}
	if reflect.ValueOf(first).Pointer() != reflect.ValueOf(second).Pointer() {
		t.Fatal("LoadCatalog 返回了两份不同的目录实例，全局缓存未生效")
	}
}

func TestLoadCatalogUnknownLanguageReturnsError(t *testing.T) {
	tests := []struct {
		name     string
		language Language
	}{
		{name: "unsupported code", language: Language("xx-XX")},
		{name: "empty language", language: Language("")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			catalog, err := LoadCatalog(tt.language)
			if err == nil {
				t.Fatalf("LoadCatalog(%q) 应返回错误，实际得到 %d 个条目", tt.language, len(catalog))
			}
			if !strings.Contains(err.Error(), "语言目录缺少") {
				t.Fatalf("错误信息应说明目录缺失，实际：%v", err)
			}
		})
	}
}

func TestLocalizerLazyLoadsAfterSetLanguage(t *testing.T) {
	localizer, err := NewLocalizer(LanguageEnUS)
	if err != nil {
		t.Fatalf("NewLocalizer(en-US) error = %v", err)
	}
	if _, loaded := catalogCache.Load(LanguageZhCN); loaded {
		t.Fatal("en-US 构造不应预载 zh-CN 目录，否则惰性加载未被覆盖")
	}
	localizer.SetLanguage(LanguageZhCN)
	text := localizer.T(commonSuccessKey, nil)
	if text == "" || text == commonSuccessKey {
		t.Fatalf("切换 zh-CN 后翻译 = %q，应返回目录中的真实文案", text)
	}
}

func TestTFallsBackToEnglishForUnloadedLanguage(t *testing.T) {
	fake := Language("zz-TEST")
	catalogCache.Store(fake, Catalog{})
	t.Cleanup(func() { catalogCache.Delete(fake) })

	localizer := &Localizer{language: fake}
	text := localizer.T(commonSuccessKey, nil)
	if text == "" || text == commonSuccessKey {
		t.Fatalf("空目录应回退 en-US，实际翻译 = %q", text)
	}
	if got := localizer.T("missing.key", nil); got != "missing.key" {
		t.Fatalf("两级都缺 key 时应返回裸 key，实际 = %q", got)
	}
}
