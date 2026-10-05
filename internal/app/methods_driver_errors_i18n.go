package app

import (
	"errors"
	"path/filepath"
	"strings"
	"unicode"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/shared/i18n"
)

func validateLocalDriverPackagePath(path string) error {
	pathText := strings.TrimSpace(path)
	if pathText == "" {
		return nil
	}
	if strings.EqualFold(filepath.Ext(pathText), ".jar") {
		return errLocalDriverPackageJDBCJarUnsupported
	}
	return nil
}

func (a *App) localizeLocalDriverPackagePathError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, errLocalDriverPackageJDBCJarUnsupported) {
		return errors.New(a.appText("driver_manager.backend.message.jdbc_jar_unsupported", nil))
	}
	return err
}

func (a *App) localizeDriverSelectionError(definition driverDefinition, err error) error {
	if err == nil {
		return nil
	}
	var buildErr *driverBuildUnavailableError
	if errors.As(err, &buildErr) {
		return errors.New(a.appText("driver_manager.backend.status.slim_build_required", map[string]any{
			"name": a.driverStatusDisplayName(definition),
		}))
	}
	var versionErr *driverVersionValidationError
	if errors.As(err, &versionErr) {
		version := normalizeVersion(strings.TrimSpace(versionErr.Version))
		if normalizeDriverType(versionErr.DriverType) == "mongodb" {
			return errors.New(a.appText("driver_manager.backend.error.mongo_version_unsupported", map[string]any{
				"version": version,
			}))
		}
		return errors.New(a.appText("driver_manager.backend.error.driver_version_unsupported", map[string]any{
			"name":    a.driverStatusDisplayName(definition),
			"version": version,
		}))
	}
	return err
}

func (a *App) driverOperationErrorMessage(err error, format string, args ...interface{}) string {
	message := a.localizedDriverOperationDetail(err)
	logger.Error(err, format, args...)
	return message
}

type localizedDriverBackendError struct {
	key    string
	params map[string]any
	cause  error
}

func (e *localizedDriverBackendError) Error() string {
	if e == nil {
		return ""
	}
	return localizedDriverBackendText(nil, e.key, e.params)
}

func (e *localizedDriverBackendError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func localizedDriverBackendText(a *App, key string, params map[string]any) string {
	if a != nil {
		return a.appText(key, params)
	}
	return defaultAppText(key, params)
}

func legacyDriverRuntimeText(key string, params map[string]any) string {
	legacyDriverRuntimeTextOnce.Do(func() {
		localizer, err := i18n.NewLocalizer(i18n.LanguageZhCN)
		if err == nil {
			legacyDriverRuntimeLocalizer = localizer
		}
	})
	if legacyDriverRuntimeLocalizer == nil {
		return defaultAppText(key, params)
	}
	return legacyDriverRuntimeLocalizer.T(key, params)
}

func extractTemplateValues(text string, template string, placeholders []string, replacements map[string]string) ([]string, bool) {
	if strings.TrimSpace(text) == "" || strings.TrimSpace(template) == "" || len(placeholders) == 0 {
		return nil, false
	}
	rendered := template
	for token, value := range replacements {
		rendered = strings.ReplaceAll(rendered, token, value)
	}
	parts := make([]string, 0, len(placeholders)+1)
	remainingTemplate := rendered
	for _, placeholder := range placeholders {
		index := strings.Index(remainingTemplate, placeholder)
		if index < 0 {
			return nil, false
		}
		parts = append(parts, remainingTemplate[:index])
		remainingTemplate = remainingTemplate[index+len(placeholder):]
	}
	parts = append(parts, remainingTemplate)

	remainingText := text
	values := make([]string, 0, len(placeholders))
	for i, part := range parts[:len(parts)-1] {
		if !strings.HasPrefix(remainingText, part) {
			return nil, false
		}
		remainingText = remainingText[len(part):]
		nextPart := parts[i+1]
		index := strings.Index(remainingText, nextPart)
		if index < 0 {
			return nil, false
		}
		values = append(values, strings.TrimSpace(remainingText[:index]))
		remainingText = remainingText[index:]
	}
	if remainingText != parts[len(parts)-1] {
		return nil, false
	}
	return values, true
}

func quoteLastLetterSequence(text string) string {
	runes := []rune(text)
	end := len(runes) - 1
	for end >= 0 && !unicode.IsLetter(runes[end]) {
		end--
	}
	if end < 0 {
		return text
	}
	start := end
	for start >= 0 && unicode.IsLetter(runes[start]) {
		start--
	}
	start++
	return string(runes[:start]) + "“" + string(runes[start:end+1]) + "”" + string(runes[end+1:])
}

func newLocalizedDriverBackendError(key string, params map[string]any, cause error) error {
	copied := make(map[string]any, len(params)+1)
	for name, value := range params {
		copied[name] = value
	}
	if cause != nil {
		if _, ok := copied["detail"]; !ok {
			copied["detail"] = cause.Error()
		}
	}
	return &localizedDriverBackendError{key: key, params: copied, cause: cause}
}

func localizedDriverBackendErrorMessage(a *App, err error) string {
	if err == nil {
		return ""
	}
	var localized *localizedDriverBackendError
	if errors.As(err, &localized) && localized != nil && strings.TrimSpace(localized.key) != "" {
		return localizedDriverBackendText(a, localized.key, localized.params)
	}
	return errorMessage(err)
}

func (a *App) localizedDriverOperationDetail(err error) string {
	message := localizedDriverBackendErrorMessage(a, err)
	if strings.TrimSpace(message) == "" {
		message = a.appText("driver_manager.backend.error.unknown", nil)
	}
	return strings.TrimSpace(message) + a.localizedDriverLogHint()
}

func (a *App) localizedDriverLogHint() string {
	path := strings.TrimSpace(logger.Path())
	if path == "" {
		return ""
	}
	return a.appText("driver_manager.backend.message.log_hint", map[string]any{"path": path})
}

func (a *App) driverStatusDisplayName(definition driverDefinition) string {
	name := strings.TrimSpace(definition.Name)
	if name != "" {
		return name
	}
	name = strings.TrimSpace(definition.Type)
	if name != "" {
		return name
	}
	return a.appText("driver_manager.backend.driver_fallback_name", nil)
}

func parseDriverAgentArchIncompatibleDetail(detail string) (string, string, bool) {
	const prefix = "driver agent architecture is incompatible (file="
	const middle = ", current process="
	const suffix = ")"

	if !strings.HasPrefix(detail, prefix) || !strings.HasSuffix(detail, suffix) {
		return "", "", false
	}
	rest := detail[len(prefix) : len(detail)-len(suffix)]
	mid := strings.Index(rest, middle)
	if mid < 0 {
		return "", "", false
	}
	fileText := strings.TrimSpace(rest[:mid])
	processText := rest[mid+len(middle):]
	if fileText == "" || processText == "" {
		return "", "", false
	}
	return fileText, processText, true
}

func parseDriverAgentUnavailableDetail(reason string, name string) (string, bool) {
	const (
		nameToken   = "<<driver-name>>"
		detailToken = "<<driver-detail>>"
	)
	template := legacyDriverRuntimeText("driver_manager.backend.status.agent_unavailable_reinstall", map[string]any{
		"name":   nameToken,
		"detail": detailToken,
	})
	candidates := []string{
		template,
		strings.Replace(template, detailToken+"。", detailToken+"；", 1),
	}
	for _, candidate := range candidates {
		values, ok := extractTemplateValues(reason, candidate, []string{detailToken}, map[string]string{nameToken: strings.TrimSpace(name)})
		if !ok || len(values) != 1 || strings.TrimSpace(values[0]) == "" {
			continue
		}
		return strings.TrimSpace(values[0]), true
	}
	return "", false
}

func parseDriverAgentArchIncompatibleReason(reason string, name string) (string, string, bool) {
	const (
		nameToken    = "<<driver-name>>"
		fileToken    = "<<driver-file>>"
		processToken = "<<driver-process>>"
	)
	template := legacyDriverRuntimeText("driver_manager.backend.status.agent_arch_incompatible_detail", map[string]any{
		"name":    nameToken,
		"file":    fileToken,
		"process": processToken,
	})
	values, ok := extractTemplateValues(reason, template, []string{fileToken, processToken}, map[string]string{
		nameToken: strings.TrimSpace(name),
	})
	if !ok || len(values) != 2 || strings.TrimSpace(values[0]) == "" || strings.TrimSpace(values[1]) == "" {
		return "", "", false
	}
	return strings.TrimSpace(values[0]), strings.TrimSpace(values[1]), true
}

func (a *App) localizeDriverRuntimeReason(definition driverDefinition, reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return ""
	}

	name := a.driverStatusDisplayName(definition)
	switch reason {
	case legacyDriverRuntimeText("driver_manager.backend.status.unrecognized_driver_type", nil):
		return a.appText("driver_manager.backend.status.unrecognized_driver_type", nil)
	case legacyDriverRuntimeText("driver_manager.backend.status.slim_build_required", map[string]any{"name": name}):
		return a.appText("driver_manager.backend.status.slim_build_required", map[string]any{"name": name})
	case legacyDriverRuntimeText("driver_manager.backend.status.agent_path_failed", map[string]any{"name": name}):
		return a.appText("driver_manager.backend.status.agent_path_failed", map[string]any{"name": name})
	case legacyDriverRuntimeText("driver_manager.backend.status.agent_missing", map[string]any{"name": name}):
		return a.appText("driver_manager.backend.status.agent_missing", map[string]any{"name": name})
	case legacyDriverRuntimeText("driver_manager.backend.status.optional_disabled", map[string]any{"name": name}),
		quoteLastLetterSequence(legacyDriverRuntimeText("driver_manager.backend.status.optional_disabled", map[string]any{"name": name})):
		return a.appText("driver_manager.backend.status.optional_disabled", map[string]any{"name": name})
	}

	if fileText, processText, ok := parseDriverAgentArchIncompatibleReason(reason, name); ok {
		return a.appText("driver_manager.backend.status.agent_arch_incompatible_detail", map[string]any{
			"name":    name,
			"file":    fileText,
			"process": processText,
		})
	}

	if detail, ok := parseDriverAgentUnavailableDetail(reason, name); ok {
		if fileText, processText, ok := parseDriverAgentArchIncompatibleDetail(detail); ok {
			return a.appText("driver_manager.backend.status.agent_arch_incompatible_detail", map[string]any{
				"name":    name,
				"file":    fileText,
				"process": processText,
			})
		}
		return a.appText("driver_manager.backend.status.agent_unavailable_reinstall", map[string]any{
			"name":   name,
			"detail": detail,
		})
	}

	return reason
}

func (a *App) localizedDriverNeedsUpdateTexts(actual string, expected string, affectedConnections int) (string, string) {
	// revision 细节不再拼进用户可见的状态文案。
	reason := a.appText("driver_manager.backend.status.needs_update", nil)
	messageParts := []string{reason}
	if affectedConnections > 0 {
		messageParts = append(messageParts, a.appText("driver_manager.backend.status.affected_connections", map[string]any{"count": affectedConnections}))
	}
	return reason, strings.Join(messageParts, " ")
}
