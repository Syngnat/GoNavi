package provider

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

type grokCLIAuthModelConfig struct {
	APIKey string `toml:"api_key"`
	EnvKey any    `toml:"env_key"`
	Model  string `toml:"model"`
}

type grokCLIAuthConfig struct {
	APIKey string `toml:"api_key"`
	Models struct {
		Default string `toml:"default"`
		APIKey  string `toml:"api_key"`
	} `toml:"models"`
	Model map[string]grokCLIAuthModelConfig `toml:"model"`
}

// withGrokCLIAuth builds a short-lived isolated Grok home without discarding
// the credential selected by the user's model. Grok's model-scoped API-key
// config must not receive an OIDC token, while subscription models need the
// user's auth.json to survive the isolation boundary.
func withGrokCLIAuth(env []string, model string) ([]string, func()) {
	noop := func() {}
	source := grokCLIConfigPathFromEnv(env)
	config, err := os.ReadFile(source)
	if err != nil {
		return env, noop
	}
	useAPIKey, err := grokCLIConfigUsesAPIKey(config, env, model)
	if err != nil {
		return env, noop
	}

	var home string
	var cleanup func()
	if useAPIKey {
		home, cleanup, err = prepareGrokCLIAPIKeyHome(source)
	} else {
		home, cleanup, err = prepareGrokCLIOAuthHome(source)
	}
	if err != nil {
		return env, noop
	}
	return upsertEnv(env, "GROK_HOME", home), cleanup
}

// grokCLIConfigUsesAPIKey detects the credential attached to the selected
// model, rather than any API key attached to a different model in the same
// Grok config. This is what lets a subscription model such as grok-4.7
// coexist with a model-specific custom-gateway key such as grok-4.6.
func grokCLIConfigUsesAPIKey(config []byte, env []string, model string) (bool, error) {
	for _, key := range []string{"XAI_API_KEY", "GROK_API_KEY"} {
		if strings.TrimSpace(envValue(env, key)) != "" {
			return true, nil
		}
	}

	var parsed grokCLIAuthConfig
	if _, err := toml.Decode(string(config), &parsed); err != nil {
		return false, err
	}
	selectedModel := strings.TrimSpace(model)
	if selectedModel == "" {
		selectedModel = strings.TrimSpace(parsed.Models.Default)
	}
	if selected := parsed.Model[selectedModel]; grokCLIModelUsesAPIKey(selected, env) {
		return true, nil
	}
	for _, selected := range parsed.Model {
		if strings.TrimSpace(selected.Model) == selectedModel && grokCLIModelUsesAPIKey(selected, env) {
			return true, nil
		}
	}
	return strings.TrimSpace(parsed.APIKey) != "" || strings.TrimSpace(parsed.Models.APIKey) != "", nil
}

func grokCLIModelUsesAPIKey(config grokCLIAuthModelConfig, env []string) bool {
	if strings.TrimSpace(config.APIKey) != "" {
		return true
	}
	for _, key := range grokCLIEnvKeyNames(config.EnvKey) {
		if strings.TrimSpace(envValue(env, key)) != "" {
			return true
		}
	}
	return false
}

func grokCLIEnvKeyNames(value any) []string {
	var values []string
	switch typed := value.(type) {
	case string:
		values = []string{typed}
	case []string:
		values = typed
	case []any:
		values = make([]string, 0, len(typed))
		for _, item := range typed {
			if key, ok := item.(string); ok {
				values = append(values, key)
			}
		}
	}
	result := make([]string, 0, len(values))
	for _, key := range values {
		if key = strings.TrimSpace(key); key != "" {
			result = append(result, key)
		}
	}
	return result
}

func grokCLIConfigPathFromEnv(env []string) string {
	if home := strings.TrimSpace(envValue(env, "GROK_HOME")); home != "" {
		return filepath.Join(home, "config.toml")
	}
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return ""
	}
	return filepath.Join(userHome, ".grok", "config.toml")
}

func prepareGrokCLIAPIKeyHome(sourceConfig string) (string, func(), error) {
	noop := func() {}
	data, err := os.ReadFile(sourceConfig)
	if err != nil {
		return "", noop, err
	}
	return prepareGrokCLIHome(pinGrokAPIKeyAuth(string(data)), nil, false)
}

// prepareGrokCLIOAuthHome keeps only the config and the OIDC credential file
// needed by a subscription invocation. User MCP servers, skills, and session
// state remain outside the child process's temporary home.
func prepareGrokCLIOAuthHome(sourceConfig string) (string, func(), error) {
	noop := func() {}
	data, err := os.ReadFile(sourceConfig)
	if err != nil {
		return "", noop, err
	}
	auth, err := os.ReadFile(filepath.Join(filepath.Dir(sourceConfig), "auth.json"))
	if err != nil {
		return "", noop, err
	}
	return prepareGrokCLIHome(pinGrokOIDCAuth(string(data)), auth, true)
}

func prepareGrokCLIHome(config string, auth []byte, includeAuth bool) (string, func(), error) {
	noop := func() {}
	home, err := os.MkdirTemp("", "gonavi-grok-home-")
	if err != nil {
		return "", noop, err
	}
	cleanup := func() { _ = os.RemoveAll(home) }
	if err := os.Chmod(home, 0o700); err != nil {
		cleanup()
		return "", noop, err
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		cleanup()
		return "", noop, err
	}
	if includeAuth {
		if err := os.WriteFile(filepath.Join(home, "auth.json"), auth, 0o600); err != nil {
			cleanup()
			return "", noop, err
		}
	}
	return home, cleanup, nil
}

// pinGrokAPIKeyAuth 把自动鉴权钉在 api_key 上，避免缓存的登录令牌盖过模型配置里的密钥。
func pinGrokAPIKeyAuth(config string) string {
	return pinGrokAuthMethod(config, "api_key")
}

// pinGrokOIDCAuth makes the isolated subscription process use the copied
// OAuth credential even when the user's shared config prefers an API key.
func pinGrokOIDCAuth(config string) string {
	return pinGrokAuthMethod(config, "oidc")
}

func pinGrokAuthMethod(config string, method string) string {
	lines := strings.Split(config, "\n")
	out := make([]string, 0, len(lines)+3)
	inAuth := false
	sawAuth := false
	replaced := false
	flushAuthKey := func() {
		if inAuth && !replaced {
			out = append(out, `preferred_method = "`+method+`"`)
			replaced = true
		}
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			flushAuthKey()
			inAuth = trimmed == "[auth]"
			if inAuth {
				sawAuth = true
			}
			out = append(out, line)
			continue
		}
		if inAuth && strings.HasPrefix(trimmed, "preferred_method") {
			out = append(out, `preferred_method = "`+method+`"`)
			replaced = true
			continue
		}
		out = append(out, line)
	}
	flushAuthKey()
	if !sawAuth {
		if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
			out = append(out, "")
		}
		out = append(out, "[auth]", `preferred_method = "`+method+`"`)
	}
	return strings.Join(out, "\n")
}
