package aiservice

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/shared/i18n"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func aiServiceFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("service.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func TestAIGetBuiltinPromptsUsesCurrentLanguageForPromptTitles(t *testing.T) {
	service := NewServiceWithSecretStore(nil)
	service.AISetLanguage("en-US")

	prompts := service.AIGetBuiltinPrompts()
	if _, ok := prompts["General chat assistant"]; !ok {
		t.Fatalf("expected English builtin prompt title, got keys %v", mapKeys(prompts))
	}
	for _, legacyTitle := range []string{"通用聊天助手", "SQL 生成器", "SQL 解析器", "SQL 优化器", "数据洞察分析", "表结构审查"} {
		if _, ok := prompts[legacyTitle]; ok {
			t.Fatalf("expected no legacy Chinese builtin prompt title %q in en-US mode", legacyTitle)
		}
	}
}

func mapKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	return keys
}

func TestAIServiceLocalizeProviderHealthCheckRequestErrorSupportsEnglishWrappers(t *testing.T) {
	service := NewService()
	service.AISetLanguage("en-US")

	cases := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "create_request_failed",
			input: "create request failed: parse \"http://[::1\": missing ']' in host",
			want:  "Failed to create request: parse \"http://[::1\": missing ']' in host",
		},
		{
			name:  "serialize_request_failed",
			input: "serialize request failed: unsupported value",
			want:  "Failed to serialize request: unsupported value",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := service.localizeProviderHealthCheckRequestError(errors.New(tc.input))
			if err == nil {
				t.Fatalf("expected localized error for %q", tc.input)
			}
			if err.Error() != tc.want {
				t.Fatalf("expected localized health-check error %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), "创建请求失败") || strings.Contains(err.Error(), "序列化请求失败") {
				t.Fatalf("expected no Chinese health-check wrapper text, got %q", err.Error())
			}
		})
	}
}

func TestAIServiceProviderSelectionCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"ai_service.backend.error.active_provider_not_found",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing AI service provider-selection key %q", language, key)
			}
		}
	}
}

func TestAIServiceModelListCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"ai_service.backend.error.models_request_create_failed",
		"ai_service.backend.error.models_request_failed",
		"ai_service.backend.error.models_http_status_failed",
		"ai_service.backend.error.models_parse_failed",
		"ai_service.backend.error.volcengine_coding_models_empty",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing AI service model-list key %q", language, key)
			}
		}
	}
}

func TestAIServiceMCPServerCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"ai_service.backend.error.mcp_command_required",
		"ai_service.backend.message.mcp_test_success",
		"ai_service.backend.error.mcp_server_not_found",
		"ai_service.backend.error.mcp_server_disabled",
		"ai_service.backend.error.mcp_tool_arguments_parse_failed",
		"ai_service.backend.error.mcp_tool_alias_invalid",
		"ai_service.backend.error.mcp_transport_unsupported",
		"ai_service.backend.message.skill_unnamed",
		"ai_chat.panel.tool_error.mcp_failed",
		"ai_chat.panel.tool_error.mcp_failed_with_detail",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing MCP service key %q", language, key)
			}
		}
	}
}

func TestAIServiceMCPHTTPServerCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"ai_settings.mcp_http.message.started",
		"ai_settings.mcp_http.message.stopped",
		"ai_settings.mcp_http.status.not_running",
		"ai_service.backend.error.mcp_http_start_failed",
		"ai_service.backend.error.mcp_http_stop_failed",
		"ai_service.backend.error.mcp_http_process_exited",
		"ai_service.backend.error.mcp_http_executable_resolve_failed",
		"ai_service.backend.error.mcp_http_subprocess_exited",
		"ai_service.backend.error.mcp_http_health_status_failed",
		"ai_service.backend.error.mcp_http_token_generate_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing MCP HTTP service key %q", language, key)
			}
		}
	}
}

func TestGetActiveProviderUsesEnglishProviderNotConfiguredMessage(t *testing.T) {
	service := NewService()
	service.AISetLanguage("en-US")

	_, err := service.getActiveProvider()
	if err == nil {
		t.Fatal("expected missing provider error")
	}

	const want = "AI Provider is not configured. Configure one in Settings first."
	if err.Error() != want {
		t.Fatalf("expected localized provider-not-configured message %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "未配置 AI Provider，请先在设置中配置") {
		t.Fatalf("expected no Chinese provider-not-configured text, got %q", err.Error())
	}
}

func TestAIListModelsUsesEnglishMissingActiveProviderMessage(t *testing.T) {
	service := NewService()
	service.AISetLanguage("en-US")
	service.providers = []ai.ProviderConfig{
		{
			ID:      "provider-1",
			Type:    "openai",
			BaseURL: "https://api.openai.com/v1",
			Model:   "gpt-4o-mini",
		},
	}
	service.activeProvider = "missing-provider"

	result := service.AIListModels()
	if success, _ := result["success"].(bool); success {
		t.Fatalf("expected missing active provider failure, got %+v", result)
	}

	errorText, _ := result["error"].(string)
	const want = "Active AI Provider was not found"
	if errorText != want {
		t.Fatalf("expected localized missing-active-provider message %q, got %q", want, errorText)
	}
	if strings.Contains(errorText, "未找到活跃 Provider") {
		t.Fatalf("expected no Chinese missing-active-provider text, got %q", errorText)
	}
}

func TestAIServiceMCPServerUsesEnglishMessages(t *testing.T) {
	t.Run("save_command_required", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")

		err := service.AISaveMCPServer(ai.MCPServerConfig{
			Name:    "Filesystem",
			Enabled: true,
		})
		if err == nil {
			t.Fatal("expected missing MCP command error")
		}

		const want = "MCP command cannot be empty"
		if err.Error() != want {
			t.Fatalf("expected localized MCP command-required message %q, got %q", want, err.Error())
		}
		if strings.Contains(err.Error(), "MCP 服务命令不能为空") {
			t.Fatalf("expected no Chinese MCP command-required text, got %q", err.Error())
		}
	})

	t.Run("test_command_required", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")

		result := service.AITestMCPServer(ai.MCPServerConfig{
			Name:    "Filesystem",
			Enabled: true,
		})
		if success, _ := result["success"].(bool); success {
			t.Fatalf("expected MCP test failure, got %+v", result)
		}

		message, _ := result["message"].(string)
		const want = "MCP command cannot be empty"
		if message != want {
			t.Fatalf("expected localized MCP test command-required message %q, got %q", want, message)
		}
		if strings.Contains(message, "MCP 服务命令不能为空") {
			t.Fatalf("expected no Chinese MCP test command-required text, got %q", message)
		}
	})

	t.Run("call_server_not_found", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")

		_, err := service.AICallMCPTool("mcp__missing-server__list_tools", "{}")
		if err == nil {
			t.Fatal("expected missing MCP server error")
		}

		const want = "MCP server was not found: missing-server"
		if err.Error() != want {
			t.Fatalf("expected localized missing-server message %q, got %q", want, err.Error())
		}
		if strings.Contains(err.Error(), "未找到 MCP 服务") {
			t.Fatalf("expected no Chinese missing-server text, got %q", err.Error())
		}
	})

	t.Run("call_server_disabled", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")
		service.mcpServers = []ai.MCPServerConfig{
			{
				ID:      "server-disabled",
				Name:    "Filesystem",
				Command: "node",
				Enabled: false,
			},
		}

		_, err := service.AICallMCPTool("mcp__server-disabled__list_tools", "{}")
		if err == nil {
			t.Fatal("expected disabled MCP server error")
		}

		const want = "MCP server is disabled: Filesystem"
		if err.Error() != want {
			t.Fatalf("expected localized disabled-server message %q, got %q", want, err.Error())
		}
		if strings.Contains(err.Error(), "MCP 服务未启用") {
			t.Fatalf("expected no Chinese disabled-server text, got %q", err.Error())
		}
	})

	t.Run("call_arguments_parse_failed", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")
		service.mcpServers = []ai.MCPServerConfig{
			{
				ID:      "server-json",
				Name:    "Filesystem",
				Command: "node",
				Enabled: true,
			},
		}

		_, err := service.AICallMCPTool("mcp__server-json__list_tools", "{")
		if err == nil {
			t.Fatal("expected MCP tool arguments parse error")
		}

		if !strings.HasPrefix(err.Error(), "Failed to parse MCP tool arguments: ") {
			t.Fatalf("expected localized MCP arguments parse prefix, got %q", err.Error())
		}
		if strings.Contains(err.Error(), "解析 MCP 工具参数失败") {
			t.Fatalf("expected no Chinese MCP arguments parse text, got %q", err.Error())
		}
	})

	t.Run("call_invalid_alias", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")

		_, err := service.AICallMCPTool("not-an-alias", "{}")
		if err == nil {
			t.Fatal("expected invalid MCP tool alias error")
		}

		const want = "Invalid MCP tool alias: not-an-alias"
		if err.Error() != want {
			t.Fatalf("expected localized invalid-alias message %q, got %q", want, err.Error())
		}
		if strings.Contains(err.Error(), "无效的 MCP 工具别名") {
			t.Fatalf("expected no Chinese invalid-alias text, got %q", err.Error())
		}
	})

	t.Run("call_command_required_wrapped", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")
		service.mcpServers = []ai.MCPServerConfig{
			{
				ID:      "server-empty-command",
				Name:    "Filesystem",
				Command: "",
				Enabled: true,
			},
		}

		_, err := service.AICallMCPTool("mcp__server-empty-command__list_tools", "{}")
		if err == nil {
			t.Fatal("expected wrapped MCP tool call failure")
		}

		const want = "MCP tool call failed: MCP command cannot be empty"
		if err.Error() != want {
			t.Fatalf("expected localized wrapped MCP call message %q, got %q", want, err.Error())
		}
		if strings.Contains(err.Error(), "调用 MCP 工具失败") || strings.Contains(err.Error(), "MCP 服务命令不能为空") {
			t.Fatalf("expected no Chinese wrapped MCP call text, got %q", err.Error())
		}
	})
}

func TestAIServiceMCPToolErrorFallbackUsesLocalizedText(t *testing.T) {
	localizer := newServiceLocalizerForLanguage(i18n.LanguageEnUS)
	result := &mcp.CallToolResult{IsError: true}

	message := formatMCPToolCallContent(localizer, result)
	const want = "MCP tool call failed"
	if message != want {
		t.Fatalf("expected localized MCP fallback message %q, got %q", want, message)
	}
	if strings.Contains(message, "MCP 工具调用失败") {
		t.Fatalf("expected no Chinese MCP fallback text, got %q", message)
	}
}

func TestAIServiceSkillUnnamedFallbackUsesLocalizedText(t *testing.T) {
	localizer := newServiceLocalizerForLanguage(i18n.LanguageEnUS)
	normalized := normalizeSkillConfig(ai.SkillConfig{Enabled: true}, localizer)

	const want = "Unnamed Skill"
	if normalized.Name != want {
		t.Fatalf("expected localized unnamed skill %q, got %q", want, normalized.Name)
	}
	if strings.Contains(normalized.Name, "未命名 Skill") {
		t.Fatalf("expected no Chinese unnamed skill text, got %q", normalized.Name)
	}
}

func TestAIListModelsUsesEnglishLocalizedModelListErrors(t *testing.T) {
	t.Run("request_create_failed", func(t *testing.T) {
		service := NewService()
		service.AISetLanguage("en-US")
		service.providers = []ai.ProviderConfig{
			{
				ID:      "provider-invalid-url",
				Type:    "openai",
				BaseURL: "http://[::1",
			},
		}
		service.activeProvider = "provider-invalid-url"

		result := service.AIListModels()
		if success, _ := result["success"].(bool); success {
			t.Fatalf("expected invalid model-list request failure, got %+v", result)
		}

		errorText, _ := result["error"].(string)
		if !strings.HasPrefix(errorText, "Failed to create model list request: ") {
			t.Fatalf("expected localized create-request prefix, got %q", errorText)
		}
		if strings.Contains(errorText, "创建请求失败") {
			t.Fatalf("expected no Chinese create-request text, got %q", errorText)
		}
	})

	t.Run("request_failed", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		server.Close()

		service := NewService()
		service.AISetLanguage("en-US")
		service.providers = []ai.ProviderConfig{
			{
				ID:      "provider-request-failed",
				Type:    "openai",
				BaseURL: server.URL + "/v1",
			},
		}
		service.activeProvider = "provider-request-failed"

		result := service.AIListModels()
		if success, _ := result["success"].(bool); success {
			t.Fatalf("expected model-list request failure, got %+v", result)
		}

		errorText, _ := result["error"].(string)
		if !strings.HasPrefix(errorText, "Failed to request model list: ") {
			t.Fatalf("expected localized request-failed prefix, got %q", errorText)
		}
		if strings.Contains(errorText, "请求模型列表失败") {
			t.Fatalf("expected no Chinese request-failed text, got %q", errorText)
		}
	})

	t.Run("http_status_failed", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "upstream failure", http.StatusBadGateway)
		}))
		defer server.Close()

		service := NewService()
		service.AISetLanguage("en-US")
		service.providers = []ai.ProviderConfig{
			{
				ID:      "provider-http-status",
				Type:    "openai",
				BaseURL: server.URL + "/v1",
			},
		}
		service.activeProvider = "provider-http-status"

		result := service.AIListModels()
		if success, _ := result["success"].(bool); success {
			t.Fatalf("expected model-list http-status failure, got %+v", result)
		}

		errorText, _ := result["error"].(string)
		const want = "Model list endpoint returned an unexpected status (HTTP 502): upstream failure"
		if errorText != want {
			t.Fatalf("expected localized http-status error %q, got %q", want, errorText)
		}
		if strings.Contains(errorText, "获取模型列表失败") {
			t.Fatalf("expected no Chinese http-status text, got %q", errorText)
		}
	})

	t.Run("parse_failed", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":`))
		}))
		defer server.Close()

		service := NewService()
		service.AISetLanguage("en-US")
		service.providers = []ai.ProviderConfig{
			{
				ID:      "provider-parse-failed",
				Type:    "openai",
				BaseURL: server.URL + "/v1",
			},
		}
		service.activeProvider = "provider-parse-failed"

		result := service.AIListModels()
		if success, _ := result["success"].(bool); success {
			t.Fatalf("expected model-list parse failure, got %+v", result)
		}

		errorText, _ := result["error"].(string)
		if !strings.HasPrefix(errorText, "Failed to parse model list: ") {
			t.Fatalf("expected localized parse-failed prefix, got %q", errorText)
		}
		if strings.Contains(errorText, "解析模型列表失败") {
			t.Fatalf("expected no Chinese parse-failed text, got %q", errorText)
		}
	})

	t.Run("volcengine_coding_plan_empty", func(t *testing.T) {
		originalFetchModelsFunc := fetchModelsFunc
		fetchModelsFunc = func(config ai.ProviderConfig, localizer *i18n.Localizer) ([]string, error) {
			return []string{
				"qwen3-14b-20250429",
				"wan2-1-14b-t2v-250225",
			}, nil
		}
		t.Cleanup(func() {
			fetchModelsFunc = originalFetchModelsFunc
		})

		service := NewService()
		service.AISetLanguage("en-US")
		service.providers = []ai.ProviderConfig{
			{
				ID:      "provider-coding-plan",
				Type:    "openai",
				BaseURL: "https://ark.cn-beijing.volces.com/api/coding/v3",
			},
		}
		service.activeProvider = "provider-coding-plan"

		result := service.AIListModels()
		if success, _ := result["success"].(bool); success {
			t.Fatalf("expected coding-plan model-list failure, got %+v", result)
		}

		errorText, _ := result["error"].(string)
		const want = "The current endpoint did not return any available Volcengine Coding Plan models. Check account access or switch to the \"Volcengine Ark\" provider"
		if errorText != want {
			t.Fatalf("expected localized volcengine-coding-plan error %q, got %q", want, errorText)
		}
		if strings.Contains(errorText, "当前接口未返回可用的火山 Coding Plan 模型") {
			t.Fatalf("expected no Chinese coding-plan text, got %q", errorText)
		}
	})
}
