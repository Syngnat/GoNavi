package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxModelDiffRunes = 50000

type modelReview struct {
	Summary  string         `json:"summary"`
	Findings []modelFinding `json:"findings"`
}

type modelFinding struct {
	Path     string `json:"path"`
	Line     int    `json:"line"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type modelEndpoint struct {
	Name    string
	BaseURL string
	APIKey  string
	Model   string
}

// freeModelEndpoints 按 coco-framework-agent 的方式接 OpenAI 兼容接口。
// 显式配置优先；否则使用已填写的免费额度密钥，顺序为 Groq、Gemini、OpenRouter。
func freeModelEndpoints(env func(string) string) []modelEndpoint {
	if env == nil {
		return nil
	}
	if key := strings.TrimSpace(env("PR_REVIEW_API_KEY")); key != "" {
		return []modelEndpoint{customModelEndpoint(env, key)}
	}
	var endpoints []modelEndpoint
	if key := strings.TrimSpace(env("GROQ_API_KEY")); key != "" {
		endpoints = append(endpoints, modelEndpoint{
			Name: "groq", BaseURL: "https://api.groq.com/openai/v1", APIKey: key, Model: "llama-3.3-70b-versatile",
		})
	}
	if key := strings.TrimSpace(env("GEMINI_API_KEY")); key != "" {
		endpoints = append(endpoints, modelEndpoint{
			Name: "gemini", BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai", APIKey: key, Model: "gemini-2.5-flash",
		})
	}
	if key := strings.TrimSpace(env("OPENROUTER_API_KEY")); key != "" {
		endpoints = append(endpoints, modelEndpoint{
			Name: "openrouter", BaseURL: "https://openrouter.ai/api/v1", APIKey: key, Model: "meta-llama/llama-3.3-70b-instruct:free",
		})
	}
	return endpoints
}

func customModelEndpoint(env func(string) string, key string) modelEndpoint {
	baseURL := strings.TrimSpace(env("PR_REVIEW_API_BASE"))
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	model := strings.TrimSpace(env("PR_REVIEW_MODEL"))
	if model == "" {
		model = "gpt-4o-mini"
	}
	return modelEndpoint{Name: "custom", BaseURL: baseURL, APIKey: key, Model: model}
}

// reviewWithFreeModels 依次尝试可用的免费或自定义模型。都失败时返回最后一个错误。
func reviewWithFreeModels(ctx context.Context, client *http.Client, env func(string) string, files []FileChange) (string, []Finding, error) {
	endpoints := freeModelEndpoints(env)
	if len(endpoints) == 0 {
		return "", nil, nil
	}
	var lastErr error
	for _, endpoint := range endpoints {
		summary, findings, err := reviewWithModel(ctx, client, endpoint.BaseURL, endpoint.APIKey, endpoint.Model, files)
		if err == nil {
			return summary, findings, nil
		}
		lastErr = fmt.Errorf("%s: %w", endpoint.Name, err)
	}
	return "", nil, lastErr
}

// reviewWithModel 把 diff 交给 OpenAI 兼容接口。失败时返回错误，调用方仍发布规约评审。
func reviewWithModel(ctx context.Context, client *http.Client, baseURL, apiKey, model string, files []FileChange) (string, []Finding, error) {
	if strings.TrimSpace(apiKey) == "" {
		return "", nil, nil
	}
	if client == nil {
		client = &http.Client{Timeout: 45 * time.Second}
	}
	model = strings.TrimSpace(model)
	if model == "" {
		model = "llama-3.3-70b-versatile"
	}
	payload := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": modelSystemPrompt},
			{"role": "user", "content": modelUserPrompt(files)},
		},
		"response_format": map[string]string{"type": "json_object"},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", nil, err
	}
	endpoint := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if endpoint == "" {
		endpoint = "https://api.openai.com/v1"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "GoNavi-PR-Review")
	req.Header.Set("HTTP-Referer", "https://github.com/Syngnat/GoNavi")
	req.Header.Set("X-Title", "GoNavi PR Review")
	resp, err := client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", nil, fmt.Errorf("模型接口返回 HTTP %d", resp.StatusCode)
	}
	return parseModelReview(raw, files)
}

func parseModelReview(raw []byte, files []FileChange) (string, []Finding, error) {
	var envelope struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", nil, fmt.Errorf("解析模型响应失败")
	}
	if len(envelope.Choices) == 0 {
		return "", nil, fmt.Errorf("模型没有返回内容")
	}
	var parsed modelReview
	if err := json.Unmarshal([]byte(envelope.Choices[0].Message.Content), &parsed); err != nil {
		return "", nil, fmt.Errorf("模型没有返回 JSON")
	}
	return strings.TrimSpace(clipText(parsed.Summary, 2000)), modelFindings(parsed.Findings, files), nil
}

func modelFindings(items []modelFinding, files []FileChange) []Finding {
	allowed := changedPaths(files)
	var findings []Finding
	for _, item := range items {
		message := strings.TrimSpace(item.Message)
		if message == "" {
			continue
		}
		path := strings.TrimSpace(item.Path)
		line := item.Line
		if _, ok := allowed[path]; !ok {
			path = "整体"
			line = 0
		} else if !lineInDiff(path, line, files) {
			line = 0
		}
		findings = append(findings, Finding{
			Path: path, Line: line, Severity: severityWarning, Rule: "model-review",
			Message: clipText(message, 500),
		})
		if len(findings) == 8 {
			break
		}
	}
	return findings
}

func changedPaths(files []FileChange) map[string]struct{} {
	paths := make(map[string]struct{}, len(files))
	for _, file := range files {
		paths[file.Filename] = struct{}{}
	}
	return paths
}

func lineInDiff(filename string, line int, files []FileChange) bool {
	if line <= 0 {
		return false
	}
	for _, file := range files {
		if file.Filename != filename {
			continue
		}
		for _, added := range addedLines(file.Patch) {
			if added.Line == line {
				return true
			}
		}
	}
	return false
}

func modelUserPrompt(files []FileChange) string {
	var b strings.Builder
	b.WriteString("请评审下面的 pull request diff。\n")
	used := 0
	for _, file := range files {
		if strings.TrimSpace(file.Patch) == "" {
			continue
		}
		chunk := fmt.Sprintf("\nFILE %s\n%s\n", file.Filename, file.Patch)
		if used+len([]rune(chunk)) > maxModelDiffRunes {
			b.WriteString("\n[后续 diff 已截断]\n")
			break
		}
		b.WriteString(chunk)
		used += len([]rune(chunk))
	}
	return b.String()
}

func clipText(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}

const modelSystemPrompt = `你是 GoNavi 的代码评审。GoNavi 是 Wails v2 + Go + React 的数据源工作台。
只根据 diff 找具体缺陷：逻辑错误、安全问题（密码/DSN 进日志、绕过只读或生产确认）、
以及这些规约：绑定层保持薄、不要手改 frontend/wailsjs、用户可见文案走 i18n、
禁止继续膨胀 QueryEditor.tsx、App.tsx、store.ts、DataGrid.tsx、Sidebar.tsx、methods_file.go、methods_db.go、app.go。
不要评论格式、命名偏好或已经明显正确的代码。用简体中文。
只返回 JSON：{"summary":"一段总评","findings":[{"path":"仓库相对路径","line":新增行号或0,"severity":"warning","message":"问题与原因"}]}。
没有问题时 findings 为空数组，summary 写明未发现缺陷。`
