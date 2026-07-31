package aiservice

import (
	"strings"
	"testing"
	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/shared/i18n"
)


func TestFetchCursorModelsUsesEnglishCreateRequestError(t *testing.T) {
	localizer, err := i18n.NewLocalizer(i18n.LanguageEnUS)
	if err != nil {
		t.Fatalf("new localizer: %v", err)
	}

	_, err = fetchCursorModels(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "cursor-agent",
		BaseURL:   "://bad",
	}, localizer)
	if err == nil {
		t.Fatal("expected fetchCursorModels to fail")
	}
	if !strings.HasPrefix(err.Error(), "Failed to create model list request: ") {
		t.Fatalf("expected English cursor model-list wrapper, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "创建请求失败") {
		t.Fatalf("expected no raw Chinese cursor model-list wrapper, got %q", err.Error())
	}
}
