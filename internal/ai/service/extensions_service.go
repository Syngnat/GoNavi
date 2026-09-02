package aiservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/shared/i18n"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NewMCPService creates a lightweight, headless Service that only loads the
// configured MCP server definitions.  It deliberately does not start the
// Agent Run Harness or any HTTP listener, making it suitable for the CLI
// adapter, which owns its own Harness instance.  Provider secrets are not
// resolved here; MCP discovery/execution needs only the MCP portion of the
// configuration and the normal Service methods still enforce their context.
//
// The returned Service should be closed with Shutdown when the owning
// adapter exits.  A missing config file is treated as an empty MCP catalog.
func NewMCPService(ctx context.Context, configDir string) (*Service, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	configDir = strings.TrimSpace(configDir)
	if configDir == "" {
		configDir = resolveConfigDir()
	}

	service := NewService()
	service.ctx = ctx
	service.agentContext = ctx
	service.configDir = configDir

	// Inspect reads the persisted snapshot without resolving provider secret
	// bundles.  This keeps an MCP-only CLI usable even when a provider's
	// keyring entry is unavailable; the provider resolver will report that
	// separate failure when a model turn actually needs it.
	inspection, err := NewProviderConfigStoreWithLanguage(configDir, service.secretStore, service.serviceLanguage()).Inspect()
	if err != nil {
		return nil, err
	}

	language := service.serviceLanguage()
	service.mu.Lock()
	service.mcpServers = normalizeMCPServerConfigs(inspection.Snapshot.MCPServers)
	service.safetyLevel = inspection.Snapshot.SafetyLevel
	service.guard.SetPermissionLevel(service.safetyLevel)
	service.contextLevel = inspection.Snapshot.ContextLevel
	service.localizer = newServiceLocalizerForLanguage(language)
	service.mu.Unlock()
	return service, nil
}

const (
	defaultMCPServerTimeoutSeconds = 20
	minMCPServerTimeoutSeconds     = 3
	maxMCPServerTimeoutSeconds     = 120
	mcpToolAliasPrefix             = "mcp__"
)

// AIGetMCPServers 获取 MCP 服务配置
func (s *Service) AIGetMCPServers() []ai.MCPServerConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneMCPServerConfigs(s.mcpServers)
}

// AISaveMCPServer 保存/更新 MCP 服务配置
func (s *Service) AISaveMCPServer(config ai.MCPServerConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	normalized := normalizeMCPServerConfig(config)
	if normalized.Enabled && strings.TrimSpace(normalized.Command) == "" {
		return fmt.Errorf("%s", s.serviceTextLocked("ai_service.backend.error.mcp_command_required", nil))
	}

	for i := range s.mcpServers {
		if s.mcpServers[i].ID == normalized.ID {
			s.mcpServers[i] = normalized
			return s.saveConfig()
		}
	}
	s.mcpServers = append(s.mcpServers, normalized)
	return s.saveConfig()
}

// AIDeleteMCPServer 删除 MCP 服务配置
func (s *Service) AIDeleteMCPServer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	filtered := s.mcpServers[:0]
	for _, serverConfig := range s.mcpServers {
		if serverConfig.ID == id {
			continue
		}
		filtered = append(filtered, serverConfig)
	}
	s.mcpServers = append([]ai.MCPServerConfig(nil), filtered...)
	return s.saveConfig()
}

// AITestMCPServer 测试 MCP 服务连通性
func (s *Service) AITestMCPServer(config ai.MCPServerConfig) map[string]any {
	normalized := normalizeMCPServerConfig(config)
	if strings.TrimSpace(normalized.Command) == "" {
		return map[string]any{
			"success": false,
			"message": s.serviceText("ai_service.backend.error.mcp_command_required", nil),
			"tools":   []ai.MCPToolDescriptor{},
		}
	}

	tools, err := s.listMCPToolsForServer(normalized)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error(), "tools": []ai.MCPToolDescriptor{}}
	}

	return map[string]any{
		"success":   true,
		"message":   s.serviceText("ai_service.backend.message.mcp_test_success", map[string]any{"count": len(tools)}),
		"toolCount": len(tools),
		"tools":     tools,
	}
}

// AIListMCPTools 聚合所有启用的 MCP 工具。
//
// Wails does not pass a request context to bound methods, so this compatibility
// wrapper uses the Service lifecycle context.  Agent runs should use the
// context-aware ListMCPTools function below instead.
func (s *Service) AIListMCPTools() []ai.MCPToolDescriptor {
	if s == nil {
		return []ai.MCPToolDescriptor{}
	}
	descriptors, err := s.listMCPTools(s.agentLifecycleContext())
	if err != nil {
		logger.Warnf("列出 MCP 工具失败: %v", err)
		return []ai.MCPToolDescriptor{}
	}
	return descriptors
}

// ListMCPTools discovers enabled MCP tools with the caller's context.  It is
// intentionally a package function rather than a Service method: exported
// Service methods become Wails bindings, while context.Context is an internal
// lifecycle value and must never be decoded from a frontend JSON request.
// Discovery failures for an individual server are logged and skipped to retain
// the behavior of AIListMCPTools; cancellation/deadline errors are returned so
// the Harness can stop a run promptly.
func ListMCPTools(ctx context.Context, service *Service) ([]ai.MCPToolDescriptor, error) {
	if service == nil {
		return nil, errors.New("AI Service is nil")
	}
	return service.listMCPTools(ctx)
}

func (s *Service) listMCPTools(ctx context.Context) ([]ai.MCPToolDescriptor, error) {
	if s == nil {
		return nil, errors.New("AI Service is nil")
	}
	if ctx == nil {
		ctx = s.agentLifecycleContext()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	servers := cloneMCPServerConfigs(s.mcpServers)
	s.mu.RUnlock()

	descriptors := make([]ai.MCPToolDescriptor, 0)
	for _, serverConfig := range servers {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !serverConfig.Enabled {
			continue
		}
		tools, err := s.listMCPToolsForServerContext(ctx, serverConfig)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, err
			}
			logger.Warnf("列出 MCP 工具失败(server=%s): %v", serverConfig.Name, err)
			continue
		}
		descriptors = append(descriptors, tools...)
	}
	return descriptors, nil
}

// AICallMCPTool 调用指定的 MCP 工具
func (s *Service) AICallMCPTool(alias string, argumentsJSON string) (ai.MCPToolCallResult, error) {
	if s == nil {
		return ai.MCPToolCallResult{}, errors.New("AI Service is nil")
	}
	return s.callMCPTool(s.agentLifecycleContext(), alias, argumentsJSON)
}

// CallMCPTool invokes a configured MCP tool with the caller's context.  Agent
// tool executors use this entry point so cancellation, run deadlines and
// shutdown propagate through process startup and the MCP request.
func CallMCPTool(ctx context.Context, service *Service, alias string, argumentsJSON string) (ai.MCPToolCallResult, error) {
	if service == nil {
		return ai.MCPToolCallResult{}, errors.New("AI Service is nil")
	}
	return service.callMCPTool(ctx, alias, argumentsJSON)
}

func (s *Service) callMCPTool(ctx context.Context, alias string, argumentsJSON string) (ai.MCPToolCallResult, error) {
	if s == nil {
		return ai.MCPToolCallResult{}, errors.New("AI Service is nil")
	}
	if ctx == nil {
		ctx = s.agentLifecycleContext()
	}
	if err := ctx.Err(); err != nil {
		return ai.MCPToolCallResult{}, err
	}
	localizer := s.serviceLocalizerForLanguage()
	serverID, originalName, err := parseMCPToolAlias(localizer, alias)
	if err != nil {
		return ai.MCPToolCallResult{}, err
	}

	s.mu.RLock()
	serverConfig, ok := findMCPServerConfigByID(s.mcpServers, serverID)
	s.mu.RUnlock()
	if !ok {
		return ai.MCPToolCallResult{}, fmt.Errorf("%s", s.serviceText("ai_service.backend.error.mcp_server_not_found", map[string]any{
			"serverID": serverID,
		}))
	}
	if !serverConfig.Enabled {
		return ai.MCPToolCallResult{}, fmt.Errorf("%s", s.serviceText("ai_service.backend.error.mcp_server_disabled", map[string]any{
			"name": serverConfig.Name,
		}))
	}

	var arguments any = map[string]any{}
	trimmedArguments := strings.TrimSpace(argumentsJSON)
	if trimmedArguments != "" {
		if err := json.Unmarshal([]byte(trimmedArguments), &arguments); err != nil {
			return ai.MCPToolCallResult{}, s.serviceError("ai_service.backend.error.mcp_tool_arguments_parse_failed", nil, err)
		}
	}

	var callResult *mcp.CallToolResult
	err = s.withMCPClientSessionContext(ctx, localizer, serverConfig, func(sessionCtx context.Context, session *mcp.ClientSession) error {
		result, callErr := session.CallTool(sessionCtx, &mcp.CallToolParams{
			Name:      originalName,
			Arguments: arguments,
		})
		if callErr != nil {
			return callErr
		}
		callResult = result
		return nil
	})
	if err != nil {
		return ai.MCPToolCallResult{}, &mcpToolCallError{
			message: serviceTextFromLocalizer(localizer, "ai_chat.panel.tool_error.mcp_failed_with_detail", map[string]any{
				"detail": err.Error(),
			}),
			cause: err,
		}
	}
	if callResult == nil {
		return ai.MCPToolCallResult{}, errors.New("MCP tool returned an empty result")
	}

	return ai.MCPToolCallResult{
		Alias:             alias,
		ServerID:          serverConfig.ID,
		ServerName:        serverConfig.Name,
		OriginalName:      originalName,
		Title:             originalName,
		Content:           formatMCPToolCallContent(localizer, callResult),
		StructuredContent: callResult.StructuredContent,
		IsError:           callResult.IsError,
	}, nil
}

// mcpToolCallError keeps the localized, backwards-compatible message while
// preserving the underlying cancellation/deadline for Harness classification.
// A plain fmt.Errorf("%s: %w", ...) would duplicate the detail because the
// localized string already contains it.
type mcpToolCallError struct {
	message string
	cause   error
}

func (e *mcpToolCallError) Error() string {
	if e == nil {
		return "MCP tool call failed"
	}
	return e.message
}

func (e *mcpToolCallError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// AIGetSkills 获取 Skill 配置
func (s *Service) AIGetSkills() []ai.SkillConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneSkillConfigs(s.skills)
}

// AISaveSkill 保存/更新 Skill 配置
func (s *Service) AISaveSkill(config ai.SkillConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	normalized := normalizeSkillConfig(config, s.serviceLocalizerForLanguageLocked())
	for i := range s.skills {
		if s.skills[i].ID == normalized.ID {
			s.skills[i] = normalized
			return s.saveConfig()
		}
	}
	s.skills = append(s.skills, normalized)
	return s.saveConfig()
}

// AIDeleteSkill 删除 Skill 配置
func (s *Service) AIDeleteSkill(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	filtered := s.skills[:0]
	for _, skillConfig := range s.skills {
		if skillConfig.ID == id {
			continue
		}
		filtered = append(filtered, skillConfig)
	}
	s.skills = append([]ai.SkillConfig(nil), filtered...)
	return s.saveConfig()
}

func (s *Service) listMCPToolsForServer(serverConfig ai.MCPServerConfig) ([]ai.MCPToolDescriptor, error) {
	return s.listMCPToolsForServerContext(s.agentLifecycleContext(), serverConfig)
}

func (s *Service) listMCPToolsForServerContext(ctx context.Context, serverConfig ai.MCPServerConfig) ([]ai.MCPToolDescriptor, error) {
	descriptors := make([]ai.MCPToolDescriptor, 0)
	err := s.withMCPClientSessionContext(ctx, s.serviceLocalizerForLanguage(), serverConfig, func(sessionCtx context.Context, session *mcp.ClientSession) error {
		cursor := ""
		for {
			result, err := session.ListTools(sessionCtx, &mcp.ListToolsParams{Cursor: cursor})
			if err != nil {
				return err
			}
			for _, tool := range result.Tools {
				if tool == nil {
					continue
				}
				descriptors = append(descriptors, ai.MCPToolDescriptor{
					Alias:        buildMCPToolAlias(serverConfig.ID, tool.Name),
					ServerID:     serverConfig.ID,
					ServerName:   serverConfig.Name,
					OriginalName: tool.Name,
					Title:        firstNonEmpty(tool.Title, toolAnnotationsTitle(tool), tool.Name),
					Description:  strings.TrimSpace(tool.Description),
					InputSchema:  normalizeToolSchema(tool.InputSchema),
				})
			}
			if strings.TrimSpace(result.NextCursor) == "" {
				break
			}
			cursor = result.NextCursor
		}
		return nil
	})
	return descriptors, err
}

func (s *Service) withMCPClientSession(localizer *i18n.Localizer, serverConfig ai.MCPServerConfig, fn func(context.Context, *mcp.ClientSession) error) error {
	return s.withMCPClientSessionContext(s.agentLifecycleContext(), localizer, serverConfig, fn)
}

// withMCPClientSessionContext owns one MCP process/session and derives its
// server timeout from parent.  Using context.Background here would detach a
// tool call from Harness cancellation and could leave a child process alive
// after a run has been canceled or the application is shutting down.
func (s *Service) withMCPClientSessionContext(parent context.Context, localizer *i18n.Localizer, serverConfig ai.MCPServerConfig, fn func(context.Context, *mcp.ClientSession) error) error {
	if parent == nil {
		parent = s.agentLifecycleContext()
	}
	if err := parent.Err(); err != nil {
		return err
	}
	serverConfig = normalizeMCPServerConfig(serverConfig)
	if serverConfig.Transport != ai.MCPTransportStdio {
		return fmt.Errorf("%s", serviceTextFromLocalizer(localizer, "ai_service.backend.error.mcp_transport_unsupported", map[string]any{
			"transport": serverConfig.Transport,
		}))
	}
	if strings.TrimSpace(serverConfig.Command) == "" {
		return fmt.Errorf("%s", serviceTextFromLocalizer(localizer, "ai_service.backend.error.mcp_command_required", nil))
	}

	timeout := time.Duration(serverConfig.TimeoutSeconds) * time.Second
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	command := exec.CommandContext(ctx, serverConfig.Command, serverConfig.Args...)
	command.Env = append(os.Environ(), formatMCPEnv(serverConfig.Env)...)

	client := mcp.NewClient(&mcp.Implementation{
		Name:    "GoNavi",
		Version: "dev",
	}, nil)

	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		return err
	}
	defer session.Close()

	return fn(ctx, session)
}

func normalizeMCPServerConfigs(configs []ai.MCPServerConfig) []ai.MCPServerConfig {
	normalized := make([]ai.MCPServerConfig, 0, len(configs))
	for _, config := range configs {
		normalized = append(normalized, normalizeMCPServerConfig(config))
	}
	return normalized
}

func normalizeMCPServerConfig(config ai.MCPServerConfig) ai.MCPServerConfig {
	id := sanitizeExtensionID(strings.TrimSpace(config.ID), "mcp")
	if id == "" {
		id = "mcp-" + uuid.New().String()[:8]
	}

	transport := config.Transport
	if transport != ai.MCPTransportStdio {
		transport = ai.MCPTransportStdio
	}

	args := make([]string, 0, len(config.Args))
	for _, arg := range config.Args {
		trimmed := strings.TrimSpace(arg)
		if trimmed == "" {
			continue
		}
		args = append(args, trimmed)
	}

	env := make(map[string]string, len(config.Env))
	for key, value := range config.Env {
		trimmedKey := strings.TrimSpace(key)
		if trimmedKey == "" {
			continue
		}
		env[trimmedKey] = value
	}

	timeout := config.TimeoutSeconds
	if timeout <= 0 {
		timeout = defaultMCPServerTimeoutSeconds
	}
	if timeout < minMCPServerTimeoutSeconds {
		timeout = minMCPServerTimeoutSeconds
	}
	if timeout > maxMCPServerTimeoutSeconds {
		timeout = maxMCPServerTimeoutSeconds
	}

	return ai.MCPServerConfig{
		ID:             id,
		Name:           firstNonEmpty(strings.TrimSpace(config.Name), strings.TrimSpace(config.Command), "MCP Server"),
		Transport:      transport,
		Command:        strings.TrimSpace(config.Command),
		Args:           args,
		Env:            env,
		Enabled:        config.Enabled,
		TimeoutSeconds: timeout,
	}
}

func cloneMCPServerConfigs(configs []ai.MCPServerConfig) []ai.MCPServerConfig {
	cloned := make([]ai.MCPServerConfig, 0, len(configs))
	for _, config := range configs {
		next := config
		next.Args = append([]string(nil), config.Args...)
		if len(config.Env) > 0 {
			next.Env = make(map[string]string, len(config.Env))
			for key, value := range config.Env {
				next.Env[key] = value
			}
		} else {
			next.Env = map[string]string{}
		}
		cloned = append(cloned, next)
	}
	return cloned
}

func buildMCPToolAlias(serverID string, originalName string) string {
	return mcpToolAliasPrefix + sanitizeAliasPart(serverID) + "__" + sanitizeAliasPart(originalName)
}

func parseMCPToolAlias(localizer *i18n.Localizer, alias string) (string, string, error) {
	trimmed := strings.TrimSpace(alias)
	if !strings.HasPrefix(trimmed, mcpToolAliasPrefix) {
		return "", "", fmt.Errorf("%s", serviceTextFromLocalizer(localizer, "ai_service.backend.error.mcp_tool_alias_invalid", map[string]any{
			"alias": alias,
		}))
	}

	parts := strings.SplitN(strings.TrimPrefix(trimmed, mcpToolAliasPrefix), "__", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return "", "", fmt.Errorf("%s", serviceTextFromLocalizer(localizer, "ai_service.backend.error.mcp_tool_alias_invalid", map[string]any{
			"alias": alias,
		}))
	}
	return parts[0], parts[1], nil
}

func formatMCPEnv(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}

	lines := make([]string, 0, len(env))
	for key, value := range env {
		lines = append(lines, key+"="+value)
	}
	slices.Sort(lines)
	return lines
}

func normalizeToolSchema(schema any) map[string]any {
	if schema == nil {
		return map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}

	if typed, ok := schema.(map[string]any); ok {
		return typed
	}

	data, err := json.Marshal(schema)
	if err != nil {
		return map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil || result == nil {
		return map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}
	return result
}

func formatMCPToolCallContent(localizer *i18n.Localizer, result *mcp.CallToolResult) string {
	if result == nil {
		return ""
	}

	parts := make([]string, 0, len(result.Content))
	for _, item := range result.Content {
		switch typed := item.(type) {
		case *mcp.TextContent:
			if strings.TrimSpace(typed.Text) != "" {
				parts = append(parts, typed.Text)
			}
		default:
			data, err := json.Marshal(typed)
			if err != nil {
				continue
			}
			if strings.TrimSpace(string(data)) != "" {
				parts = append(parts, string(data))
			}
		}
	}

	if len(parts) == 0 && result.StructuredContent != nil {
		if data, err := json.Marshal(result.StructuredContent); err == nil {
			parts = append(parts, string(data))
		}
	}

	if len(parts) == 0 && result.IsError {
		return serviceTextFromLocalizer(localizer, "ai_chat.panel.tool_error.mcp_failed", nil)
	}
	return strings.Join(parts, "\n\n")
}

func findMCPServerConfigByID(configs []ai.MCPServerConfig, id string) (ai.MCPServerConfig, bool) {
	for _, config := range configs {
		if config.ID == id {
			return cloneMCPServerConfigs([]ai.MCPServerConfig{config})[0], true
		}
	}
	return ai.MCPServerConfig{}, false
}

func normalizeSkillConfigs(configs []ai.SkillConfig, localizer *i18n.Localizer) []ai.SkillConfig {
	normalized := make([]ai.SkillConfig, 0, len(configs))
	for _, config := range configs {
		normalized = append(normalized, normalizeSkillConfig(config, localizer))
	}
	return normalized
}

func normalizeSkillConfig(config ai.SkillConfig, localizer *i18n.Localizer) ai.SkillConfig {
	id := sanitizeExtensionID(strings.TrimSpace(config.ID), "skill")
	if id == "" {
		id = "skill-" + uuid.New().String()[:8]
	}

	requiredTools := make([]string, 0, len(config.RequiredTools))
	seenRequiredTools := make(map[string]struct{}, len(config.RequiredTools))
	for _, toolName := range config.RequiredTools {
		trimmed := strings.TrimSpace(toolName)
		if trimmed == "" {
			continue
		}
		if _, ok := seenRequiredTools[trimmed]; ok {
			continue
		}
		seenRequiredTools[trimmed] = struct{}{}
		requiredTools = append(requiredTools, trimmed)
	}

	return ai.SkillConfig{
		ID:            id,
		Name:          firstNonEmpty(strings.TrimSpace(config.Name), serviceTextFromLocalizer(localizer, "ai_service.backend.message.skill_unnamed", nil)),
		Description:   strings.TrimSpace(config.Description),
		SystemPrompt:  normalizeUserPromptText(config.SystemPrompt),
		Enabled:       config.Enabled,
		Scopes:        normalizeSkillScopes(config.Scopes),
		RequiredTools: requiredTools,
	}
}

func cloneSkillConfigs(configs []ai.SkillConfig) []ai.SkillConfig {
	cloned := make([]ai.SkillConfig, 0, len(configs))
	for _, config := range configs {
		next := config
		next.Scopes = append([]string(nil), config.Scopes...)
		next.RequiredTools = append([]string(nil), config.RequiredTools...)
		cloned = append(cloned, next)
	}
	return cloned
}

func normalizeSkillScopes(scopes []string) []string {
	if len(scopes) == 0 {
		return []string{string(ai.SkillScopeGlobal)}
	}

	allowed := map[string]struct{}{
		string(ai.SkillScopeGlobal):        {},
		string(ai.SkillScopeDatabase):      {},
		string(ai.SkillScopeJVM):           {},
		string(ai.SkillScopeJVMDiagnostic): {},
	}
	seen := make(map[string]struct{}, len(scopes))
	normalized := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		trimmed := strings.TrimSpace(scope)
		if _, ok := allowed[trimmed]; !ok {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		normalized = append(normalized, trimmed)
	}
	if len(normalized) == 0 {
		return []string{string(ai.SkillScopeGlobal)}
	}
	return normalized
}

func sanitizeExtensionID(raw string, prefix string) string {
	if raw == "" {
		return ""
	}

	var builder strings.Builder
	builder.Grow(len(raw))
	lastWasDash := false
	for _, r := range strings.ToLower(raw) {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
			lastWasDash = false
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
			lastWasDash = false
		case r == '-' || r == '_':
			if builder.Len() == 0 || lastWasDash {
				continue
			}
			builder.WriteByte('-')
			lastWasDash = true
		default:
			if builder.Len() == 0 || lastWasDash {
				continue
			}
			builder.WriteByte('-')
			lastWasDash = true
		}
	}

	sanitized := strings.Trim(builder.String(), "-")
	if sanitized == "" {
		return ""
	}
	if prefix != "" && !strings.HasPrefix(sanitized, prefix+"-") && sanitized != prefix {
		return prefix + "-" + sanitized
	}
	return sanitized
}

func sanitizeAliasPart(raw string) string {
	var builder strings.Builder
	builder.Grow(len(raw))
	for _, r := range strings.TrimSpace(raw) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '_', r == '-', r == '.':
			builder.WriteRune(r)
		default:
			builder.WriteByte('_')
		}
	}
	return strings.Trim(builder.String(), "_")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func toolAnnotationsTitle(tool *mcp.Tool) string {
	if tool == nil || tool.Annotations == nil {
		return ""
	}
	return strings.TrimSpace(tool.Annotations.Title)
}
