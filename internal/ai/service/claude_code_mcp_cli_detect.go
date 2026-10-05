package aiservice

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai/provider"
)

// localCLICommandDetectionTTL 决定命令存在性探测结果的复用窗口。
//
// 未命中缓存时，先 LookPath，再读 nvm default（文件系统，毫秒级），Unix 才退到 login shell。
// 只有 nvm 也没有的命令才要把候选 shell 各起一次，单项约 1s。
// 设置页一次要探测 7 个客户端，串行叠加就是 2–4.5s 的白屏。
// 命令是否安装在一次会话里几乎不变，因此按短 TTL 复用；安装 MCP 配置只改配置文件，
// 不改变命令存在性，所以不需要为安装动作单独失效。
var localCLICommandDetectionTTL = 60 * time.Second

type localCLICommandDetection struct {
	found     bool
	path      string
	expiresAt time.Time
}

var (
	localCLICommandDetectionMu    sync.Mutex
	localCLICommandDetectionCache = map[string]localCLICommandDetection{}
)

// localCLICommandCacheKey 把探测所依赖的三个钩子的函数身份并入键。
// 测试替换任一钩子后键即改变，缓存自然失效，因此既有用例不需要感知这层缓存，
// 也不会被上一个用例的探测结果污染。
func localCLICommandCacheKey(commandName string) string {
	return fmt.Sprintf("%s\x00%x\x00%x\x00%x",
		commandName,
		reflect.ValueOf(localCLICommandPathFunc).Pointer(),
		reflect.ValueOf(localCLICommandShellCandidatesFunc).Pointer(),
		reflect.ValueOf(localCLICommandShellOutputFunc).Pointer(),
	)
}

func lookupLocalCLICommandCache(commandName string) (localCLICommandDetection, bool) {
	localCLICommandDetectionMu.Lock()
	defer localCLICommandDetectionMu.Unlock()
	entry, ok := localCLICommandDetectionCache[localCLICommandCacheKey(commandName)]
	if !ok || time.Now().After(entry.expiresAt) {
		return localCLICommandDetection{}, false
	}
	return entry, true
}

func storeLocalCLICommandCache(commandName string, found bool, path string) {
	localCLICommandDetectionMu.Lock()
	defer localCLICommandDetectionMu.Unlock()
	localCLICommandDetectionCache[localCLICommandCacheKey(commandName)] = localCLICommandDetection{
		found:     found,
		path:      path,
		expiresAt: time.Now().Add(localCLICommandDetectionTTL),
	}
}

// resetLocalCLICommandCache 供测试清空缓存，避免用例之间互相污染。
func resetLocalCLICommandCache() {
	localCLICommandDetectionMu.Lock()
	defer localCLICommandDetectionMu.Unlock()
	localCLICommandDetectionCache = map[string]localCLICommandDetection{}
}

func detectLocalCLICommand(commandName string) (bool, string) {
	commandName = strings.TrimSpace(commandName)
	if commandName == "" {
		return false, ""
	}
	if entry, ok := lookupLocalCLICommandCache(commandName); ok {
		return entry.found, entry.path
	}
	found, path := detectLocalCLICommandUncached(commandName)
	storeLocalCLICommandCache(commandName, found, path)
	return found, path
}

func detectLocalCLICommandUncached(commandName string) (bool, string) {
	resolvedPath, err := provider.LookupLocalCLICommandUsing(provider.CLILookupHooks{
		LookPath:        localCLICommandPathFunc,
		ShellCandidates: localCLICommandShellCandidatesFunc,
		ShellOutput:     localCLICommandShellOutputFunc,
		Timeout:         localCLICommandShellLookupTimeout,
	}, commandName)
	if err != nil || strings.TrimSpace(resolvedPath) == "" {
		return false, ""
	}
	return true, filepath.Clean(strings.TrimSpace(resolvedPath))
}

func runLocalCLICommandShell(ctx context.Context, shell string, lookupCommand string) ([]byte, error) {
	return exec.CommandContext(ctx, shell, "-ilc", lookupCommand).Output()
}

func localCLICommandShellCandidates() []string {
	seen := make(map[string]struct{}, 4)
	result := make([]string, 0, 4)
	appendShell := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if _, ok := seen[value]; ok {
			return
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	appendShell(os.Getenv("SHELL"))
	appendShell("/bin/zsh")
	appendShell("/bin/bash")
	appendShell("/bin/sh")
	return result
}

func isLocalMCPClientCommandDetected(commandName string) bool {
	detected, _ := detectLocalCLICommand(commandName)
	return detected
}

func requireLocalMCPClientCommand(commandName string, displayName string, textFuncs ...mcpClientInstallTextFunc) error {
	if isLocalMCPClientCommandDetected(commandName) {
		return nil
	}
	text := firstMCPClientInstallText(textFuncs)
	return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.local_client_not_detected", map[string]any{
		"label":   strings.TrimSpace(displayName),
		"command": strings.TrimSpace(commandName),
	}))
}

func mcpClientInstallText(text mcpClientInstallTextFunc, key string, params map[string]any) string {
	if text == nil {
		return serviceTextFromLocalizer(nil, key, params)
	}
	return text(key, params)
}

func firstMCPClientInstallText(textFuncs []mcpClientInstallTextFunc) mcpClientInstallTextFunc {
	if len(textFuncs) == 0 {
		return nil
	}
	return textFuncs[0]
}

func localizeMCPClientPathDetail(text mcpClientInstallTextFunc, err error) string {
	if err == nil {
		return ""
	}
	detail := strings.TrimSpace(err.Error())
	if errors.Is(err, errMCPClientUserHomeDirUnavailable) || detail == errMCPClientUserHomeDirUnavailable.Error() {
		return mcpClientInstallText(text, "ai.service.mcp_client.user_home_dir_unavailable", nil)
	}
	return detail
}

// prewarmLocalCLICommandCache 在后台预热外部客户端探测结果。
//
// 冷路径实测约 1.2s（未安装的命令要把候选 shell 逐个起 login shell 直到超时），
// 全部发生在设置页打开的同步路径上。启动时先在后台跑一遍，用户真正打开设置页时
// 命中缓存，代价降到毫秒级。预热失败没有后果——它只是提前填缓存，
// 真正的探测逻辑与结果判定完全不变。
func prewarmLocalCLICommandCache() {
	names := []string{
		claudeCodeClientCommandName,
		codexClientCommandName,
		openCodeClientCommandName,
		cursorClientCommandName,
		zCodeClientCommandName,
		kimiCodeClientCommandName,
		deepSeekHarnessClientCommandName,
		grokBuildClientCommandName,
	}
	var wg sync.WaitGroup
	for _, name := range names {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			detectLocalCLICommand(name)
		}(name)
	}
	wg.Wait()
}
