package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
)

func TestCursorCLIResolverDoesNotConfuseOtherVendorsOrEditor(t *testing.T) {
	var tried []string
	_, err := resolveCursorCLICommand("darwin", func(name string) (string, error) {
		tried = append(tried, name)
		if name == "agent" || name == "cursor" {
			return "/other/vendor/" + name, nil
		}
		return "", exec.ErrNotFound
	})
	if err == nil || !strings.Contains(err.Error(), "cursor-agent") || !reflect.DeepEqual(tried, []string{"cursor-agent"}) {
		t.Fatalf("must fail instead of invoking another vendor/editor: %v %v", tried, err)
	}
	command, err := resolveCursorCLICommand("windows", func(name string) (string, error) {
		if name == "cursor-agent.cmd" {
			return "C:\\Cursor\\cursor-agent.cmd", nil
		}
		return "", exec.ErrNotFound
	})
	if err != nil || command != "C:\\Cursor\\cursor-agent.cmd" {
		t.Fatalf("Windows wrapper lookup failed: %q %v", command, err)
	}
}

func TestCursorCLITransportAndUnsupportedEffort(t *testing.T) {
	if _, err := NewCursorCLIProvider(ai.ProviderConfig{AuthMode: "api-key"}); err == nil {
		t.Fatal("local CLI must reject API-key mode")
	}
	local, err := NewCustomProvider(ai.ProviderConfig{APIFormat: "cursor-cli", AuthMode: "local-cli"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := local.(*CustomProvider).inner.(*CursorCLIProvider); !ok {
		t.Fatal("cursor-cli must route to the local provider")
	}
	remote, err := NewCustomProvider(ai.ProviderConfig{APIFormat: "cursor-agent", AuthMode: "api-key", BaseURL: "https://fixture.invalid/v1", APIKey: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := remote.(*CustomProvider).inner.(*CursorAgentProvider); !ok {
		t.Fatal("existing Cursor cloud API routing must be preserved")
	}
	commands := overrideCursorCLIProcess(t, "echo", "", 0)
	local, _ = NewCursorCLIProvider(ai.ProviderConfig{AuthMode: "local-cli", Effort: "high"})
	if _, err := local.Chat(context.Background(), ai.ChatRequest{}); err == nil || len(*commands) != 0 {
		t.Fatal("unsupported effort must fail before any CLI request")
	}
}

func TestCursorCLIEnvironmentRetainsNativePoliciesWithoutAPIOverrides(t *testing.T) {
	env := buildCursorCLIEnv([]string{
		"HOME=/native-home", "CURSOR_CONFIG_DIR=/native-policy", "PATH=/bin",
		"CURSOR_API_KEY=fixture", "CURSOR_AUTH_TOKEN=fixture", "CURSOR_STATSIG_OVERRIDES=fixture",
		"CURSOR_DATA_DIR=/native-data", "FORCE_COLOR=1",
	}, "/temporary-data")
	for _, key := range []string{"CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_STATSIG_OVERRIDES"} {
		if envValue(env, key) != "" {
			t.Fatalf("ambient override must be removed: %s", key)
		}
	}
	if envValue(env, "HOME") != "/native-home" || envValue(env, "CURSOR_CONFIG_DIR") != "/native-policy" || envValue(env, "CURSOR_DATA_DIR") != "/temporary-data" {
		t.Fatal("preserve native login/policies and isolate only request data")
	}
}

func TestCursorCLILoginRequiresExplicitAuthenticatedJSON(t *testing.T) {
	for _, test := range []struct {
		name, output string
		exitCode     int
		ok           bool
	}{
		{"authenticated", `{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"private-fixture"}}`, 0, true},
		{"signed-out-zero-exit", `{"status":"unauthenticated","isAuthenticated":false}`, 0, false},
		{"partial", `{"status":"partially-authenticated","isAuthenticated":false}`, 0, false},
		{"missing-boolean", `{"status":"authenticated"}`, 0, false},
		{"empty", "", 0, false},
		{"unstructured", "private-fixture login failed", 0, false},
		{"nonzero", `{"status":"authenticated","isAuthenticated":true}`, 3, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			commands := overrideCursorCLIProcess(t, "output", test.output, test.exitCode)
			err := CheckCursorCLIAuth(context.Background())
			if (err == nil) != test.ok {
				t.Fatalf("unexpected auth result: %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "private-fixture") {
				t.Fatal("login output must not leak to UI/errors")
			}
			args := (*commands)[0].Args
			if !hasArgSequence(args, "status", "--format") || !hasArgSequence(args, "--format", "json") || hasArg(args, "--print") {
				t.Fatal("login check must never send a model request")
			}
		})
	}
}

func TestCursorCLIModelCatalogParsesNativeRowsAndRejectsInvalidOutput(t *testing.T) {
	output := "\x1b[1mAvailable models\x1b[0m\n\nauto - Auto (current, default)\nsonnet-model - Sonnet\nsonnet-model - Sonnet\ncustom/model:1 (default)\n\nTip: use --model <id>\nignored-model - Ignored\n"
	commands := overrideCursorCLIProcess(t, "output", output, 0)
	capability, _ := LookupCLICapability("cursor-cli")
	catalog, err := capability.ModelCatalog(context.Background())
	if err != nil || catalog.Source != "cli" || catalog.Stale || !reflect.DeepEqual(catalog.Models, []string{"auto", "sonnet-model", "custom/model:1"}) {
		t.Fatalf("unexpected model catalog: %+v %v", catalog, err)
	}
	if !hasArg((*commands)[0].Args, "models") || hasArg((*commands)[0].Args, "--print") {
		t.Fatal("model discovery must not send a chat request")
	}
	for _, invalid := range []string{"", "No models available for this account.", "* other-vendor-model", "Available models\nPlease log in", "Available models\nError: unauthorized", "Available models\nmodel - Model\nUnknown output format"} {
		if models, err := parseCursorCLIModels(invalid); err == nil || len(models) != 0 {
			t.Fatalf("invalid/error output must not become candidates: %q %v", invalid, models)
		}
	}
}

func TestCursorCLIModelCatalogDoesNotAcceptFailedCommands(t *testing.T) {
	commands := overrideCursorCLIProcess(t, "output", "Available models\nmisleading-model - Model\n", 7)
	capability, _ := LookupCLICapability("cursor-cli")
	catalog, err := capability.ModelCatalog(context.Background())
	if err == nil || len(catalog.Models) != 0 || catalog.Source != "none" || len(*commands) != 1 {
		t.Fatalf("failed command must not project valid-looking models: %+v %v", catalog, err)
	}
}

func TestCursorCLIChatRequiresLocalSignInBeforeSendingPrompt(t *testing.T) {
	commands := overrideCursorCLIProcess(t, "echo", "", 0)
	cursorCLIAuthCheck = func(context.Context) error { return errors.New("not signed in") }
	provider, _ := NewCursorCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if _, err := provider.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "must not be sent"}}}); err == nil || len(*commands) != 0 {
		t.Fatal("the model command must not start until local sign-in passes")
	}
}

func TestCursorCLIChatUsesStdinAndTemporaryPermissions(t *testing.T) {
	commands := overrideCursorCLIProcess(t, "echo", "", 0)
	provider, _ := NewCursorCLIProvider(ai.ProviderConfig{AuthMode: "local-cli", Model: "selected-model"})
	response, err := provider.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "private prompt fixture"}}})
	if err != nil || response.Content != "private prompt fixture" {
		t.Fatalf("expected successful stdin response: %+v %v", response, err)
	}
	command := (*commands)[0]
	if strings.Contains(strings.Join(command.Args, " "), "private prompt fixture") || !hasArgSequence(command.Args, "--model", "selected-model") {
		t.Fatal("model goes in argv but prompt must stay on stdin")
	}
	if _, err := os.Stat(command.Dir); !os.IsNotExist(err) {
		t.Fatal("temporary workspace and request data must be removed")
	}
	if response.TokensUsed.TotalTokens != 0 || len(response.ToolCalls) != 0 {
		t.Fatal("do not fabricate usage or expose native agent tools")
	}
}

func TestCursorCLIChatRejectsIncompleteErrorAndNonzeroResults(t *testing.T) {
	for _, test := range []struct {
		name, output string
		exitCode     int
	}{
		{"empty", "", 0},
		{"invalid", "private prompt fixture", 0},
		{"init-only", `{"type":"system","subtype":"init"}`, 0},
		{"error", `{"type":"result","subtype":"success","is_error":true,"result":"private prompt fixture"}`, 0},
		{"missing-status", `{"type":"result","subtype":"success","result":"private prompt fixture"}`, 0},
		{"empty-content", `{"type":"result","subtype":"success","is_error":false,"result":" "}`, 0},
		{"nonzero", `{"type":"result","subtype":"success","is_error":false,"result":"private prompt fixture"}`, 9},
	} {
		t.Run(test.name, func(t *testing.T) {
			commands := overrideCursorCLIProcess(t, "output", test.output, test.exitCode)
			provider, _ := NewCursorCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
			var chunks []ai.StreamChunk
			err := provider.ChatStream(context.Background(), ai.ChatRequest{}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) })
			if err != nil || len(chunks) != 1 || !chunks[0].Done || chunks[0].Error == "" || chunks[0].Content != "" || strings.Contains(chunks[0].Error, "private prompt fixture") {
				t.Fatalf("must report failure without content or raw output: %v %+v", err, chunks)
			}
			if _, err := os.Stat((*commands)[0].Dir); !os.IsNotExist(err) {
				t.Fatal("failed requests must clean up their workspace")
			}
		})
	}
}

func TestCursorCLIChatStreamEmitsPartialTextThenDone(t *testing.T) {
	partial := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Hel"}]}}`,
		`{"type":"content_block_delta","delta":{"text":"lo"}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Hello"}`,
	}, "\n")
	overrideCursorCLIProcess(t, "output", partial+"\n", 0)
	provider, _ := NewCursorCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	var chunks []ai.StreamChunk
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hi"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	}); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if len(chunks) != 3 || chunks[0].Content != "Hel" || chunks[1].Content != "lo" || !chunks[2].Done || chunks[2].Content != "" {
		t.Fatalf("result line must not duplicate streamed text: %#v", chunks)
	}
}

func TestCursorCLIDeadlinesCancellationAndOutputBounds(t *testing.T) {
	commands := overrideCursorCLIProcess(t, "wait", "", 0)
	_, err := runCursorCLICommand(context.Background(), []string{"models"}, "", 100*time.Millisecond, 1024)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected bounded timeout: %v", err)
	}
	if _, err := os.Stat((*commands)[0].Dir); !os.IsNotExist(err) {
		t.Fatal("timed out request did not clean up")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	provider, _ := NewCursorCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err := provider.ChatStream(ctx, ai.ChatRequest{}, func(ai.StreamChunk) { t.Fatal("canceled request must not emit success/error chunks") }); !errors.Is(err, context.Canceled) || len(*commands) != 1 {
		t.Fatalf("cancellation must not start another process: %v", err)
	}
	for _, scenario := range []string{"overflow-stdout", "overflow-stderr"} {
		t.Run(scenario, func(t *testing.T) {
			overrideCursorCLIProcess(t, scenario, "", 0)
			_, err := runCursorCLICommand(context.Background(), []string{"models"}, "", 3*time.Second, 1024)
			if err == nil || !strings.Contains(err.Error(), "output limit") {
				t.Fatalf("must stop and bound excessive output: %v", err)
			}
		})
	}
}

// Every command below is this test executable, never the installed Cursor CLI.
func overrideCursorCLIProcess(t *testing.T, scenario, output string, exitCode int) *[]*exec.Cmd {
	t.Helper()
	originalLookPath, originalCommand, originalAuth := cursorLookPath, cursorCommandContext, cursorCLIAuthCheck
	t.Cleanup(func() {
		cursorLookPath, cursorCommandContext, cursorCLIAuthCheck = originalLookPath, originalCommand, originalAuth
	})
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	commands := make([]*exec.Cmd, 0)
	cursorLookPath = func(string) (string, error) { return executable, nil }
	cursorCLIAuthCheck = func(context.Context) error { return nil }
	cursorCommandContext = func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		command := exec.CommandContext(ctx, executable, append([]string{"-test.run=^TestCursorCLIHelperProcess$", "--", scenario}, args...)...)
		command.Env = append(os.Environ(), "GONAVI_CURSOR_HELPER=1", "GONAVI_CURSOR_OUTPUT="+output, "GONAVI_CURSOR_EXIT="+strconv.Itoa(exitCode), "GORACE=atexit_sleep_ms=0")
		commands = append(commands, command)
		return command
	}
	return &commands
}

func TestCursorCLIHelperProcess(t *testing.T) {
	if os.Getenv("GONAVI_CURSOR_HELPER") != "1" {
		return
	}
	separator := 0
	for index, arg := range os.Args {
		if arg == "--" {
			separator = index
			break
		}
	}
	scenario, args := os.Args[separator+1], os.Args[separator+2:]
	switch scenario {
	case "wait":
		time.Sleep(10 * time.Second)
	case "overflow-stdout":
		_, _ = io.WriteString(os.Stdout, strings.Repeat("x", 128*1024))
	case "overflow-stderr":
		_, _ = io.WriteString(os.Stderr, strings.Repeat("x", 128*1024))
	case "echo":
		workspace, err := os.Getwd()
		if err != nil || !hasArgSequence(args, "--workspace", workspace) || !hasArgSequence(args, "--mode", "ask") || !hasArgSequence(args, "--sandbox", "enabled") || !hasArg(args, "--trust") || hasArg(args, "--force") || hasArg(args, "--yolo") || hasArg(args, "--approve-mcps") {
			os.Exit(31)
		}
		configPath := filepath.Join(workspace, ".cursor", "cli.json")
		config, err := os.ReadFile(configPath)
		var permissions struct {
			Permissions struct{ Allow, Deny []string } `json:"permissions"`
		}
		if err != nil || json.Unmarshal(config, &permissions) != nil || len(permissions.Permissions.Allow) != 0 {
			os.Exit(32)
		}
		for _, token := range []string{"Shell(*)", "Read(**)", "Read(/**)", "Write(**)", "Write(/**)", "WebFetch(*)", "Mcp(*:*)"} {
			if !hasArg(permissions.Permissions.Deny, token) {
				os.Exit(33)
			}
		}
		info, _ := os.Stat(configPath)
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			os.Exit(34)
		}
		if os.Getenv("CURSOR_DATA_DIR") != filepath.Join(workspace, "data") {
			os.Exit(35)
		}
		prompt, _ := io.ReadAll(os.Stdin)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "is_error": false, "result": string(prompt)})
	default:
		fmt.Fprint(os.Stdout, os.Getenv("GONAVI_CURSOR_OUTPUT"))
	}
	exitCode, _ := strconv.Atoi(os.Getenv("GONAVI_CURSOR_EXIT"))
	os.Exit(exitCode)
}
