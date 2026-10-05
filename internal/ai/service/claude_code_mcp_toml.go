package aiservice

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

func parseCodexMCPServerConfig(content string, serverID string, textFuncs ...mcpClientInstallTextFunc) (codexMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	mainHeader := fmt.Sprintf("[mcp_servers.%s]", strings.TrimSpace(serverID))
	result := codexMCPServerConfig{}
	found := false
	inside := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inside {
			if trimmed == mainHeader {
				inside = true
				found = true
			}
			continue
		}
		if isTOMLHeaderLine(trimmed) {
			break
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		key, value, ok := splitTOMLAssignment(trimmed)
		if !ok {
			continue
		}
		switch key {
		case "command":
			parsed, err := parseTOMLString(value)
			if err != nil {
				return result, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.command", strings.TrimSpace(serverID)), "expected": "a TOML string"}))
			}
			result.Command = parsed
		case "args":
			parsed, err := parseTOMLStringArray(value)
			if err != nil {
				return result, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.args", strings.TrimSpace(serverID)), "expected": "a TOML string array"}))
			}
			result.Args = parsed
		case "startup_timeout_sec":
			parsed, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return result, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.startup_timeout_sec", strings.TrimSpace(serverID)), "expected": "an integer"}))
			}
			result.StartupTimeoutSec = parsed
		}
	}

	return result, found, nil
}

func replaceOrAppendTOMLMCPServerBlock(content string, serverID string, block string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	mainHeader := fmt.Sprintf("[mcp_servers.%s]", serverID)
	nestedPrefix := fmt.Sprintf("[mcp_servers.%s.", serverID)

	start, end := -1, -1
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if start == -1 {
			if trimmed == mainHeader || strings.HasPrefix(trimmed, nestedPrefix) {
				start = index
			}
			continue
		}
		if isTOMLHeaderLine(trimmed) && trimmed != mainHeader && !strings.HasPrefix(trimmed, nestedPrefix) {
			end = index
			break
		}
	}
	if start != -1 && end == -1 {
		end = len(lines)
	}

	rendered := strings.TrimRight(block, "\n")
	if start == -1 {
		base := strings.TrimSpace(strings.Join(lines, "\n"))
		if base == "" {
			return rendered + "\n"
		}
		return strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n\n" + rendered + "\n"
	}

	before := strings.TrimRight(strings.Join(lines[:start], "\n"), "\n")
	after := strings.TrimLeft(strings.Join(lines[end:], "\n"), "\n")
	switch {
	case before == "" && after == "":
		return rendered + "\n"
	case before == "":
		return rendered + "\n\n" + after
	case after == "":
		return before + "\n\n" + rendered + "\n"
	default:
		return before + "\n\n" + rendered + "\n\n" + after
	}
}

// replaceOrAppendCodexMCPServerBlock preserves the existing helper name for
// callers and tests that were added before other TOML MCP clients existed.
func replaceOrAppendCodexMCPServerBlock(content string, serverID string, block string) string {
	return replaceOrAppendTOMLMCPServerBlock(content, serverID, block)
}

func renderTomlStringArray(values []string) []string {
	rendered := make([]string, 0, len(values))
	for _, value := range values {
		rendered = append(rendered, tomlString(value))
	}
	return rendered
}

func tomlString(value string) string {
	if !strings.Contains(value, "'") && !strings.Contains(value, "\n") && !strings.Contains(value, "\r") {
		return "'" + value + "'"
	}
	return strconv.Quote(value)
}

func splitTOMLAssignment(line string) (string, string, bool) {
	index := strings.Index(line, "=")
	if index <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(line[:index])
	value := strings.TrimSpace(line[index+1:])
	if key == "" {
		return "", "", false
	}
	return key, value, true
}

func parseTOMLString(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 {
		return "", fmt.Errorf("invalid string format")
	}
	switch value[0] {
	case '\'':
		if value[len(value)-1] != '\'' {
			return "", fmt.Errorf("single-quoted string is not closed")
		}
		return value[1 : len(value)-1], nil
	case '"':
		parsed, err := strconv.Unquote(value)
		if err != nil {
			return "", err
		}
		return parsed, nil
	default:
		return "", fmt.Errorf("not a string")
	}
}

func parseTOMLStringArray(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return []string{}, nil
	}
	if !strings.HasPrefix(value, "[") || !strings.HasSuffix(value, "]") {
		return nil, fmt.Errorf("not an array")
	}

	inner := strings.TrimSpace(value[1 : len(value)-1])
	if inner == "" {
		return []string{}, nil
	}

	result := make([]string, 0, 4)
	for inner != "" {
		item, rest, err := consumeTOMLQuotedString(inner)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
		inner = strings.TrimSpace(rest)
		if inner == "" {
			break
		}
		if !strings.HasPrefix(inner, ",") {
			return nil, fmt.Errorf("invalid array separator")
		}
		inner = strings.TrimSpace(inner[1:])
	}
	return result, nil
}

func consumeTOMLQuotedString(value string) (string, string, error) {
	value = strings.TrimLeft(value, " \t")
	if value == "" {
		return "", "", fmt.Errorf("string is empty")
	}
	switch value[0] {
	case '\'':
		end := strings.IndexByte(value[1:], '\'')
		if end < 0 {
			return "", "", fmt.Errorf("single-quoted string is not closed")
		}
		end++
		return value[1:end], value[end+1:], nil
	case '"':
		escaped := false
		for index := 1; index < len(value); index++ {
			ch := value[index]
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == '"' {
				parsed, err := strconv.Unquote(value[:index+1])
				if err != nil {
					return "", "", err
				}
				return parsed, value[index+1:], nil
			}
		}
		return "", "", fmt.Errorf("double-quoted string is not closed")
	default:
		return "", "", fmt.Errorf("not a string")
	}
}

func decodeJSONLikeStringSlice(value any) ([]string, error) {
	switch typed := value.(type) {
	case nil:
		return []string{}, nil
	case []string:
		return append([]string(nil), typed...), nil
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			str, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("array element is not a string")
			}
			result = append(result, str)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("not a string array")
	}
}

func anyString(value any) string {
	text, _ := value.(string)
	return text
}

func sameMCPCommand(actualCommand string, actualArgs []string, expectedCommand string, expectedArgs []string) bool {
	return strings.TrimSpace(actualCommand) == strings.TrimSpace(expectedCommand) &&
		reflect.DeepEqual(normalizeStringSlice(actualArgs), normalizeStringSlice(expectedArgs))
}

func normalizeStringSlice(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, strings.TrimSpace(value))
	}
	return result
}

func isTOMLHeaderLine(line string) bool {
	line = strings.TrimSpace(line)
	return strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]")
}
