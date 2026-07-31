package aiservice

import (
	"strings"
	"testing"
	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/shared/i18n"
)


func TestAIServiceAdditionalSessionAndModelCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"ai_service.backend.error.models_remote_unsupported",
		"ai_service.backend.error.session_provider_messages_serialize_failed",
		"ai_chat.panel.session.default_title",
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing AI service key %q", language, key)
			}
		}
	}
}

func TestAIServiceNewConversationTitleUsesCurrentLanguage(t *testing.T) {
	service := NewServiceWithSecretStore(nil)
	service.AISetLanguage("en-US")
	service.configDir = t.TempDir()

	sessionData, err := service.loadOrCreateSessionFile("session-1")
	if err != nil {
		t.Fatalf("loadOrCreateSessionFile: %v", err)
	}
	if got, want := sessionData.Title, "New chat"; got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestNewModelsRequestUsesLocalizedUnsupportedRemoteListMessage(t *testing.T) {
	localizer, err := i18n.NewLocalizer(i18n.LanguageEnUS)
	if err != nil {
		t.Fatalf("new localizer: %v", err)
	}

	_, err = newModelsRequest(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "codebuddy-cli",
	}, localizer)
	if err == nil {
		t.Fatal("expected unsupported remote model list error")
	}
	if got, want := err.Error(), "create request failed: Remote model listing is not supported for the current provider"; got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}
