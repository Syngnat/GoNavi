package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
)

const codexModelCatalogMaxAge = 24 * time.Hour
const codexModelCatalogMaxBytes = 8 * 1024 * 1024
const codexAppServerModelListMaxPages = 10

type CLIModelCapability struct {
	EffortValues  []string `json:"effortValues"`
	DefaultEffort string   `json:"defaultEffort,omitempty"`
}

// CLIModelCatalog contains suggestions only. Even a fresh catalog does not
// prove account entitlement or that a model can produce a response.
type CLIModelCatalog struct {
	Models            []string                      `json:"models"`
	Source            string                        `json:"source"`
	Stale             bool                          `json:"stale"`
	DefaultModel      string                        `json:"defaultModel,omitempty"`
	ModelCapabilities map[string]CLIModelCapability `json:"modelCapabilities,omitempty"`
}

var codexAppServerModelCatalog = queryCodexAppServerModelCatalog

func (c CLICapability) ModelCatalog(ctx context.Context) (CLIModelCatalog, error) {
	return c.ModelCatalogWithConfig(ctx, ai.ProviderConfig{})
}

func (c CLICapability) ModelCatalogWithConfig(ctx context.Context, config ai.ProviderConfig) (CLIModelCatalog, error) {
	result := CLIModelCatalog{Models: []string{}, Source: "none"}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if len(c.ModelDiscoveryArgs) > 0 {
		models, err := c.DiscoverModelsWithConfig(ctx, config)
		if err != nil {
			return result, err
		}
		return CLIModelCatalog{Models: models, Source: "cli"}, nil
	}
	if c.ModelCatalogSource == "claude-aliases" {
		// Documented common aliases, not an account's available-model list.
		// Claude resolves versions and enforces access when a request is made.
		// https://code.claude.com/docs/en/model-config#model-aliases
		return CLIModelCatalog{Models: []string{"sonnet", "opus", "haiku"}, Source: "aliases"}, nil
	}
	if c.ModelCatalogSource != "codex-cache" {
		return result, nil
	}
	codexDir := strings.TrimSpace(config.CLIEnv["CODEX_HOME"])
	if codexDir == "" {
		codexDir = strings.TrimSpace(os.Getenv("CODEX_HOME"))
	}
	// model/list is Codex's public runtime discovery surface. It reflects the
	// active login and current server catalog, and also returns per-model effort
	// capabilities. models_cache.json is only a compatibility fallback for older
	// CLIs or a temporarily unavailable app-server.
	appServerCatalog, appServerErr := codexAppServerModelCatalog(ctx, config)
	if appServerErr == nil && len(appServerCatalog.Models) > 0 {
		return appServerCatalog, nil
	}
	if codexDir == "" {
		userDir, err := os.UserHomeDir()
		if err != nil {
			return result, fmt.Errorf("Codex local model catalog is unavailable")
		}
		codexDir = filepath.Join(userDir, ".codex")
	}
	cacheCatalog, cacheErr := readCodexModelCatalog(filepath.Join(codexDir, "models_cache.json"), time.Now())
	if cacheErr == nil {
		return cacheCatalog, nil
	}
	if appServerErr != nil {
		return result, appServerErr
	}
	return result, cacheErr
}

type codexAppServerRPCError struct {
	Message string `json:"message"`
}

type codexAppServerRPCResponse struct {
	ID     int                     `json:"id"`
	Result json.RawMessage         `json:"result"`
	Error  *codexAppServerRPCError `json:"error"`
}

func queryCodexAppServerModelCatalog(ctx context.Context, config ai.ProviderConfig) (CLIModelCatalog, error) {
	result := CLIModelCatalog{Models: []string{}, Source: "app-server", ModelCapabilities: map[string]CLIModelCapability{}}
	queryCtx, cancel := context.WithTimeout(ctx, modelDiscoveryTimeout)
	defer cancel()
	command, err := resolveCodexCLICommand(runtime.GOOS, runtime.GOARCH, lookPathWithOverride(config.CLIPath, cliModelLookPath), fileExists)
	if err != nil {
		return result, err
	}
	args := append(append([]string(nil), command.PrefixArgs...), "app-server")
	cmd := newLocalCLICommand(codexCommandContext, queryCtx, command.Path, args...)
	cmd.WaitDelay = time.Second
	cmd.Env = buildCodexCLIEnvWithConfig(cmd.Environ(), command.Path, config.CLIEnv)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return result, fmt.Errorf("create Codex app-server stdin failed: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return result, fmt.Errorf("create Codex app-server stdout failed: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return result, fmt.Errorf("start Codex app-server failed: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		cancel()
		_ = cmd.Wait()
	}()

	encoder := json.NewEncoder(stdin)
	decoder := json.NewDecoder(io.LimitReader(stdout, codexModelCatalogMaxBytes+1))
	if err := encoder.Encode(map[string]interface{}{
		"method": "initialize", "id": 1,
		"params": map[string]interface{}{"clientInfo": map[string]string{
			"name": "gonavi", "title": "GoNavi", "version": "1",
		}},
	}); err != nil {
		return result, fmt.Errorf("initialize Codex app-server failed: %w", err)
	}
	if _, err := waitForCodexAppServerResponse(decoder, 1, &stderr); err != nil {
		return result, err
	}
	if err := encoder.Encode(map[string]interface{}{"method": "initialized", "params": map[string]interface{}{}}); err != nil {
		return result, fmt.Errorf("acknowledge Codex app-server failed: %w", err)
	}

	seen := make(map[string]struct{})
	cursor := ""
	for page := 0; page < codexAppServerModelListMaxPages; page++ {
		requestID := page + 2
		params := map[string]interface{}{"limit": 100, "includeHidden": false}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if err := encoder.Encode(map[string]interface{}{"method": "model/list", "id": requestID, "params": params}); err != nil {
			return result, fmt.Errorf("request Codex model catalog failed: %w", err)
		}
		raw, err := waitForCodexAppServerResponse(decoder, requestID, &stderr)
		if err != nil {
			return result, err
		}
		pageCatalog, nextCursor, err := parseCodexAppServerModelList(raw)
		if err != nil {
			return result, err
		}
		for _, model := range pageCatalog.Models {
			if _, ok := seen[model]; ok {
				continue
			}
			seen[model] = struct{}{}
			result.Models = append(result.Models, model)
			if capability, ok := pageCatalog.ModelCapabilities[model]; ok {
				result.ModelCapabilities[model] = capability
			}
		}
		if result.DefaultModel == "" {
			result.DefaultModel = pageCatalog.DefaultModel
		}
		cursor = nextCursor
		if cursor == "" {
			break
		}
	}
	if len(result.Models) == 0 {
		return result, fmt.Errorf("Codex app-server model/list returned no visible models")
	}
	return result, nil
}

func waitForCodexAppServerResponse(decoder *json.Decoder, requestID int, stderr *bytes.Buffer) (json.RawMessage, error) {
	for {
		var response codexAppServerRPCResponse
		if err := decoder.Decode(&response); err != nil {
			detail := strings.TrimSpace(stderr.String())
			if detail != "" {
				return nil, fmt.Errorf("read Codex app-server response failed: %w: %s", err, RedactAIUpstreamLogText(detail))
			}
			return nil, fmt.Errorf("read Codex app-server response failed: %w", err)
		}
		if response.ID != requestID {
			continue
		}
		if response.Error != nil {
			return nil, fmt.Errorf("Codex app-server request failed: %s", RedactAIUpstreamLogText(response.Error.Message))
		}
		if len(response.Result) == 0 {
			return nil, fmt.Errorf("Codex app-server request returned no result")
		}
		return response.Result, nil
	}
}

func parseCodexAppServerModelList(raw json.RawMessage) (CLIModelCatalog, string, error) {
	result := CLIModelCatalog{Models: []string{}, Source: "app-server", ModelCapabilities: map[string]CLIModelCapability{}}
	var response struct {
		Data []struct {
			ID                        string `json:"id"`
			Model                     string `json:"model"`
			Hidden                    bool   `json:"hidden"`
			IsDefault                 bool   `json:"isDefault"`
			DefaultReasoningEffort    string `json:"defaultReasoningEffort"`
			SupportedReasoningEfforts []struct {
				ReasoningEffort string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
		} `json:"data"`
		NextCursor *string `json:"nextCursor"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return result, "", fmt.Errorf("Codex app-server returned an invalid model catalog: %w", err)
	}
	seen := make(map[string]struct{})
	for _, entry := range response.Data {
		model := strings.TrimSpace(entry.Model)
		if model == "" {
			model = strings.TrimSpace(entry.ID)
		}
		if entry.Hidden || model == "" || len(model) > 256 || strings.ContainsAny(model, " \t\r\n") {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		result.Models = append(result.Models, model)
		if entry.IsDefault && result.DefaultModel == "" {
			result.DefaultModel = model
		}
		efforts := make([]string, 0, len(entry.SupportedReasoningEfforts))
		effortSeen := make(map[string]struct{})
		for _, option := range entry.SupportedReasoningEfforts {
			effort := strings.ToLower(strings.TrimSpace(option.ReasoningEffort))
			if effort == "" || len(effort) > 64 || strings.ContainsAny(effort, " \t\r\n") {
				continue
			}
			if _, ok := effortSeen[effort]; ok {
				continue
			}
			effortSeen[effort] = struct{}{}
			efforts = append(efforts, effort)
		}
		defaultEffort := strings.ToLower(strings.TrimSpace(entry.DefaultReasoningEffort))
		if len(efforts) > 0 {
			result.ModelCapabilities[model] = CLIModelCapability{EffortValues: efforts, DefaultEffort: defaultEffort}
		}
	}
	nextCursor := ""
	if response.NextCursor != nil {
		nextCursor = strings.TrimSpace(*response.NextCursor)
	}
	return result, nextCursor, nil
}

func readCodexModelCatalog(filePath string, now time.Time) (CLIModelCatalog, error) {
	result := CLIModelCatalog{Models: []string{}, Source: "cache"}
	file, err := os.Open(filePath)
	if err != nil {
		return result, fmt.Errorf("Codex local model catalog is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > codexModelCatalogMaxBytes {
		return result, fmt.Errorf("Codex local model catalog cannot be read")
	}
	if age := now.Sub(info.ModTime()); age > codexModelCatalogMaxAge || age < -5*time.Minute {
		result.Stale = true
		return result, nil
	}
	// Decode only public model identifiers and visibility. Never project the
	// catalog's model instructions, prompts, or other metadata into the UI.
	var document struct {
		Models []struct {
			Slug                  string `json:"slug"`
			Visibility            string `json:"visibility"`
			DefaultReasoningLevel string `json:"default_reasoning_level"`
			SupportedReasoning    []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	decoder := json.NewDecoder(io.LimitReader(file, codexModelCatalogMaxBytes+1))
	if err := decoder.Decode(&document); err != nil {
		return result, fmt.Errorf("Codex local model catalog is invalid")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return result, fmt.Errorf("Codex local model catalog is invalid")
	}
	seen := make(map[string]bool)
	result.ModelCapabilities = make(map[string]CLIModelCapability)
	for _, model := range document.Models {
		slug := strings.TrimSpace(model.Slug)
		if model.Visibility != "list" || slug == "" || len(slug) > 256 || strings.ContainsAny(slug, " \t\r\n") || seen[slug] {
			continue
		}
		seen[slug] = true
		result.Models = append(result.Models, slug)
		efforts := make([]string, 0, len(model.SupportedReasoning))
		for _, option := range model.SupportedReasoning {
			effort := strings.ToLower(strings.TrimSpace(option.Effort))
			if effort != "" && !strings.ContainsAny(effort, " \t\r\n") {
				efforts = append(efforts, effort)
			}
		}
		if len(efforts) > 0 {
			result.ModelCapabilities[slug] = CLIModelCapability{
				EffortValues: efforts, DefaultEffort: strings.ToLower(strings.TrimSpace(model.DefaultReasoningLevel)),
			}
		}
	}
	return result, nil
}
