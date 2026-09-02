package provider

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestCursorAndCodeBuddySourceUseEnglishErrorWrappers(t *testing.T) {
	t.Parallel()

	checks := []struct {
		path          string
		signature     string
		rawMessages   []string
		requiredTexts []string
	}{
		{
			path:        "cursor_agent.go",
			signature:   "func (p *CursorAgentProvider) Validate() error {",
			rawMessages: []string{`"API Key 不能为空"`},
			requiredTexts: []string{
				`"API key is required"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func (p *CursorAgentProvider) ChatWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest) (*ai.ChatResponse, json.RawMessage, error) {",
			rawMessages: []string{
				`"序列化 Cursor 会话状态失败: %w"`,
			},
			requiredTexts: []string{
				`"serialize Cursor session state failed: %w"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func (p *CursorAgentProvider) ChatStreamWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest, callback func(ai.StreamChunk)) (json.RawMessage, error) {",
			rawMessages: []string{
				`"Cursor 流式请求失败"`,
				`"未收到任何有效响应内容，请检查 Cursor 配置或模型权限"`,
				`"读取 Cursor 流式响应失败: %w"`,
			},
			requiredTexts: []string{
				`"Cursor stream request failed"`,
				`"No valid response content was received. Check the Cursor configuration or model access."`,
				`"read Cursor stream response failed: %w"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func (p *CursorAgentProvider) createAgent(ctx context.Context, req ai.ChatRequest) (string, string, error) {",
			rawMessages: []string{
				`"Cursor 创建 agent 成功，但未返回有效的 agentId/runId"`,
			},
			requiredTexts: []string{
				`"Cursor created an agent but returned no valid agentId/runId"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func buildCursorPrompt(messages []ai.Message) (string, error) {",
			rawMessages: []string{
				`"请结合这些图片继续分析并回答。"`,
				`"请求内容不能为空"`,
			},
			requiredTexts: []string{
				`providerImageFallbackPrompt`,
				`"request content is required"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func buildCursorImageInputs(messages []ai.Message) ([]cursorImageInput, error) {",
			rawMessages: []string{
				`"解析图片数据失败: %w"`,
				`"Cursor 最多支持 5 张图片，当前请求包含 %d 张"`,
			},
			requiredTexts: []string{
				`"parse image data failed: %w"`,
				`"Cursor supports at most 5 images per request; got %d"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func (p *CursorAgentProvider) getRun(ctx context.Context, agentID string, runID string) (*cursorRunResponse, error) {",
			rawMessages: []string{
				`"创建 Cursor run 查询失败: %w"`,
				`"查询 Cursor run 状态失败: %w"`,
				`"Cursor run 查询失败 (HTTP %d): %s"`,
				`"解析 Cursor run 响应失败: %w"`,
			},
			requiredTexts: []string{
				`"create Cursor run request failed: %w"`,
				`"request Cursor run status failed: %w"`,
				`"Cursor run request failed (HTTP %d): %s"`,
				`"parse Cursor run response failed: %w"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func (p *CursorAgentProvider) createRun(ctx context.Context, agentID string, req ai.ChatRequest) (string, error) {",
			rawMessages: []string{
				`"Cursor 创建 follow-up run 成功，但未返回有效 runId"`,
			},
			requiredTexts: []string{
				`"Cursor created a follow-up run but returned no valid runId"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func (p *CursorAgentProvider) openRunStream(ctx context.Context, agentID string, runID string) (io.ReadCloser, error) {",
			rawMessages: []string{
				`"创建 Cursor 流式请求失败: %w"`,
				`"发送 Cursor 流式请求失败: %w"`,
				`"Cursor API 返回错误 (HTTP %d): %s"`,
			},
			requiredTexts: []string{
				`"create Cursor stream request failed: %w"`,
				`"request Cursor stream failed: %w"`,
				`"Cursor API returned error (HTTP %d): %s"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func (p *CursorAgentProvider) doJSONRequest(ctx context.Context, method string, endpoint string, body any, target any, accept string) error {",
			rawMessages: []string{
				`"序列化 Cursor 请求失败: %w"`,
				`"创建 Cursor 请求失败: %w"`,
				`"发送 Cursor 请求失败: %w"`,
				`"Cursor API 返回错误 (HTTP %d): %s"`,
				`"解析 Cursor 响应失败: %w"`,
			},
			requiredTexts: []string{
				`"serialize Cursor request failed: %w"`,
				`"create Cursor request failed: %w"`,
				`"request Cursor failed: %w"`,
				`"Cursor API returned error (HTTP %d): %s"`,
				`"parse Cursor response failed: %w"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func parseCursorSessionState(state json.RawMessage) (cursorSessionState, error) {",
			rawMessages: []string{
				`"解析 Cursor 会话状态失败: %w"`,
			},
			requiredTexts: []string{
				`"parse Cursor session state failed: %w"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func marshalCursorSessionState(state cursorSessionState) (json.RawMessage, error) {",
			rawMessages: []string{
				`"序列化 Cursor 会话状态失败: %w"`,
			},
			requiredTexts: []string{
				`"serialize Cursor session state failed: %w"`,
			},
		},
		{
			path:      "cursor_agent.go",
			signature: "func cursorRunStatusMessage(status string, result string) string {",
			rawMessages: []string{
				`"Cursor 运行结束（%s）：%s"`,
				`"Cursor 运行结束（%s）"`,
			},
			requiredTexts: []string{
				`"Cursor run finished (%s): %s"`,
				`"Cursor run finished (%s)"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func (p *CodeBuddyCLIProvider) ChatWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest) (*ai.ChatResponse, json.RawMessage, error) {",
			rawMessages: []string{
				`"CodeBuddy CLI 执行超时`,
				`"CodeBuddy CLI 执行失败: %s"`,
				`"CodeBuddy CLI 执行失败: %w"`,
			},
			requiredTexts: []string{
				`"CodeBuddy CLI timed out`,
				`"CodeBuddy CLI execution failed: %s"`,
				`"CodeBuddy CLI execution failed: %w"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func (p *CodeBuddyCLIProvider) chatStreamWithSession(ctx context.Context, resumeSessionID string, req ai.ChatRequest, callback func(ai.StreamChunk)) (string, error) {",
			rawMessages: []string{
				`"创建 stdout 管道失败: %w"`,
				`"启动 CodeBuddy CLI 失败: %w"`,
				`"CodeBuddy CLI 鉴权失败: %s"`,
				`"CodeBuddy CLI 返回错误: %s"`,
				`"CodeBuddy CLI 执行超时`,
				`"CodeBuddy CLI 异常退出: %v"`,
				`"CodeBuddy CLI 异常退出: %s"`,
			},
			requiredTexts: []string{
				`"create stdout pipe failed: %w"`,
				`"start CodeBuddy CLI failed: %w"`,
				`"CodeBuddy CLI authentication failed: %s"`,
				`"CodeBuddy CLI returned an error: %s"`,
				`"CodeBuddy CLI timed out`,
				`"CodeBuddy CLI exited unexpectedly: %v"`,
				`"CodeBuddy CLI exited unexpectedly: %s"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func parseCodeBuddySessionState(state json.RawMessage) (codebuddySessionState, error) {",
			rawMessages: []string{
				`"解析 CodeBuddy 会话状态失败: %w"`,
			},
			requiredTexts: []string{
				`"parse CodeBuddy session state failed: %w"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func marshalCodeBuddySessionState(sessionID string) (json.RawMessage, error) {",
			rawMessages: []string{
				`"序列化 CodeBuddy 会话状态失败: %w"`,
			},
			requiredTexts: []string{
				`"serialize CodeBuddy session state failed: %w"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func resolveCodeBuddyCLICommand(lookPath func(string) (string, error)) (string, error) {",
			rawMessages: []string{
				`"未找到 codebuddy 命令，请先安装 CodeBuddy CLI: npm install -g @tencent-ai/codebuddy-code"`,
			},
			requiredTexts: []string{
				`"CodeBuddy CLI command not found. Install it first: npm install -g @tencent-ai/codebuddy-code"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func resolveCodeBuddyGitBashPath(env []string, goos string, lookPath func(string) (string, error), exists func(string) bool) (string, error) {",
			rawMessages: []string{
				`"CodeBuddy CLI 在 Windows 下配置的 CODEBUDDY_CODE_GIT_BASH_PATH 不存在: %s"`,
			},
			requiredTexts: []string{
				`"Configured CODEBUDDY_CODE_GIT_BASH_PATH does not exist on Windows: %s"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func buildCodeBuddyCLIResponseFromEvents(events []cliStreamEvent) (*ai.ChatResponse, string, error) {",
			rawMessages: []string{
				`"CodeBuddy CLI 返回错误: %s"`,
			},
			requiredTexts: []string{
				`"CodeBuddy CLI returned an error: %s"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func extractCodeBuddyCLIEventError(event cliStreamEvent) (string, bool) {",
			rawMessages: []string{
				`"CodeBuddy CLI 返回未知错误"`,
			},
			requiredTexts: []string{
				`"CodeBuddy CLI returned an unknown error"`,
			},
		},
		{
			path:      "codebuddy_cli.go",
			signature: "func extractCodeBuddyCLISystemRetryError(event cliStreamEvent) (string, bool) {",
			rawMessages: []string{
				`"CodeBuddy CLI 鉴权失败 (HTTP %d): %s"`,
				`"CodeBuddy CLI 鉴权失败: %s"`,
			},
			requiredTexts: []string{
				`"CodeBuddy CLI authentication failed (HTTP %d): %s"`,
				`"CodeBuddy CLI authentication failed: %s"`,
			},
		},
	}

	for _, check := range checks {
		functionSource := providerFunctionSource(t, check.path, check.signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw provider text %q", check.signature, rawMessage)
			}
		}
		for _, requiredText := range check.requiredTexts {
			if !strings.Contains(functionSource, requiredText) {
				t.Fatalf("%s does not reference english wrapper %q", check.signature, requiredText)
			}
		}
	}
}

func TestCursorAgentProviderUsesEnglishValidationAndFallbackMessages(t *testing.T) {
	t.Parallel()

	providerInstance, err := NewCursorAgentProvider(ai.ProviderConfig{})
	if err != nil {
		t.Fatalf("create cursor provider failed: %v", err)
	}

	err = providerInstance.Validate()
	if err == nil {
		t.Fatal("expected missing api key error")
	}
	if got, want := err.Error(), "API key is required"; got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}

	text, err := buildCursorPrompt([]ai.Message{{Role: "user", Images: []string{"data:image/png;base64,aGVsbG8="}}})
	if err != nil {
		t.Fatalf("expected image-only prompt fallback, got %v", err)
	}
	if got, want := text, "Please describe and analyze this image."; got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestBuildCursorImageInputsRejectsTooManyImagesInEnglish(t *testing.T) {
	t.Parallel()

	images := make([]string, 0, 6)
	for i := 0; i < 6; i++ {
		images = append(images, "data:image/png;base64,aGVsbG8=")
	}

	_, err := buildCursorImageInputs([]ai.Message{{Role: "user", Content: "analyze", Images: images}})
	if err == nil {
		t.Fatal("expected too-many-images error")
	}
	if got, want := err.Error(), "Cursor supports at most 5 images per request; got 6"; got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestCodeBuddyCLIUsesEnglishInstallHint(t *testing.T) {
	t.Parallel()

	_, err := resolveCodeBuddyCLICommand(func(string) (string, error) {
		return "", errors.New("not found")
	})
	if err == nil {
		t.Fatal("expected missing command error")
	}
	if got, want := err.Error(), "CodeBuddy CLI command not found. Install it first: npm install -g @tencent-ai/codebuddy-code"; got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestBuildCodeBuddyCLIResponseFromEventsUsesEnglishErrorWrapper(t *testing.T) {
	t.Parallel()

	_, _, err := buildCodeBuddyCLIResponseFromEvents([]cliStreamEvent{
		{
			Type:    "error",
			IsError: true,
			Result:  "token expired",
		},
	})
	if err == nil {
		t.Fatal("expected codebuddy response error")
	}
	if got, want := err.Error(), "CodeBuddy CLI returned an error: token expired"; got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}
