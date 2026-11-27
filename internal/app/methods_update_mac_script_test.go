package app

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLaunchMacUpdateRunsInstallerSynchronously(t *testing.T) {
	original := runMacUpdateInstaller
	t.Cleanup(func() { runMacUpdateInstaller = original })

	root := t.TempDir()
	staged := &stagedUpdate{
		WorkspaceDir:   filepath.Join(root, "updates"),
		StagedDir:      filepath.Join(root, "updates", "stage"),
		FilePath:       filepath.Join(root, "updates", "GoNavi-test.dmg"),
		InstallLogPath: filepath.Join(root, "updates", "stage", "update.log"),
	}
	targetExe := filepath.Join(root, "GoNavi.app", "Contents", "MacOS", "GoNavi")
	installErr := errors.New("installer failed")
	called := false
	runMacUpdateInstaller = func(scriptPath string, workDir string) error {
		called = true
		if workDir != staged.StagedDir {
			t.Fatalf("workDir = %q, want %q", workDir, staged.StagedDir)
		}
		payload, err := os.ReadFile(scriptPath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(payload), "mode=before-exit") {
			t.Fatalf("script is not in synchronous mode:\n%s", payload)
		}
		return installErr
	}

	err := launchMacUpdate(staged, targetExe, 4242)
	if !called {
		t.Fatal("launchMacUpdate returned without running the installer")
	}
	if !errors.Is(err, installErr) {
		t.Fatalf("err = %v, want installer error", err)
	}
}

func TestBuildMacScriptContainsHardeningGuards(t *testing.T) {
	script := buildMacScript(
		"/tmp/GoNavi/updates/1.2.3/GoNavi-1.2.3-MacOS-Arm64.dmg",
		"/Applications/GoNavi.app",
		"/tmp/GoNavi/updates",
		"/tmp/GoNavi/updates/1.2.3/stage",
		"/tmp/GoNavi/updates/1.2.3/stage/mnt",
		"/tmp/GoNavi/updates/1.2.3/gonavi-update-macos.log",
		4242,
	)

	mustContain := []string{
		"hdiutil attach",
		"prepare_app_source_from_package",
		"resolve_app_binary_rel",
		"replace_app_direct",
		"run_admin_replace",
		"relaunch_app",
		`RESTART_PARENT_ARG="--gonavi-restart-parent-pid=${PID}"`,
		`open -n "$TARGET_APP" --args "$RESTART_PARENT_ARG"`,
		`nohup "$TARGET_APP/$APP_BIN_REL" "$RESTART_PARENT_ARG" >/dev/null 2>&1 &`,
		"mode=before-exit",
		// 安装包扩展名分支
		"dmg)",
		"zip)",
		// 所有失败路径都必须留下可检索的日志；主进程会把错误返回给前端。
		"fail_update",
		// relaunch 成功后删除整个 updates 目录，失败则保留
		`/bin/rm -rf "$UPDATES_DIR"`,
	}
	for _, token := range mustContain {
		if !strings.Contains(script, token) {
			t.Fatalf("mac update script missing required token %q\nscript:\n%s", token, script)
		}
	}
	if strings.Contains(script, `rm -rf "$MOUNT_DIR" "$DMG" "$STAGED"`) {
		t.Fatal("mac update script must not delete STAGED while the script may still be running from it")
	}
	if strings.Contains(script, "com.apple.quarantine") || strings.Contains(script, "xattr -rd") {
		t.Fatal("mac updater must preserve Gatekeeper quarantine metadata; notarized releases must not depend on clearing it")
	}
	// 确保不会在 relaunch 之前删除 updates 目录。
	rmIdx := strings.Index(script, `/bin/rm -rf "$UPDATES_DIR"`)
	relaunchIdx := strings.Index(script, "if ! relaunch_app; then")
	if rmIdx < 0 || relaunchIdx < 0 || rmIdx < relaunchIdx {
		t.Fatalf("updates cleanup must happen only after relaunch attempt (rmIdx=%d relaunchIdx=%d)", rmIdx, relaunchIdx)
	}
	if strings.Contains(script[rmIdx+len(`/bin/rm -rf "$UPDATES_DIR"`):], `log "`) {
		t.Fatal("mac update script must not write installation logs after deleting the updates directory")
	}
	if strings.Contains(script, `while /bin/kill -0 "$PID"`) || strings.Contains(script, "host process exited") {
		t.Fatal("mac update script must install before the host exits instead of waiting for process death")
	}
	if !strings.Contains(script, "/tmp/GoNavi/updates/1.2.3/GoNavi-1.2.3-MacOS-Arm64.dmg") {
		t.Fatal("expected package path embedded in script")
	}
	if !strings.Contains(script, "/Applications/GoNavi.app") {
		t.Fatal("expected target app path embedded in script")
	}
	if !strings.Contains(script, "PID=4242") {
		t.Fatal("expected host pid embedded in script")
	}
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	cmd := exec.Command(bash, "-n")
	cmd.Stdin = strings.NewReader(script)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generated mac update script failed bash -n: %v\n%s", err, output)
	}
}

func TestResolveMacUpdateTargetFallsBackFromAppTranslocation(t *testing.T) {
	got := resolveMacUpdateTarget("/private/var/folders/xx/AppTranslocation/ABC/d/GoNavi.app/Contents/MacOS/GoNavi")
	if got != "/Applications/GoNavi.app" {
		t.Fatalf("expected AppTranslocation fallback, got %q", got)
	}
	got = resolveMacUpdateTarget("/Applications/GoNavi.app/Contents/MacOS/GoNavi")
	if got != "/Applications/GoNavi.app" {
		t.Fatalf("expected normal app bundle path, got %q", got)
	}
}

// 管理员替换曾经写成 `osascript <<'EOF' arg1...`：没有 `-` 时 osascript 会把第一个参数
// 当成脚本文件名，报 -2740 语法错误后退出 1，内置 AppleScript 从不执行。
// 于是「无权限直接替换」这条唯一兜底路径必然失败。
func TestBuildMacScriptAdminReplacePassesStdinAndArgs(t *testing.T) {
	script := buildMacScript(
		"/tmp/GoNavi/updates/1.2.3/GoNavi-1.2.3-MacOS-Arm64.dmg",
		"/Applications/GoNavi.app",
		"/tmp/GoNavi/updates",
		"/tmp/GoNavi/updates/1.2.3/stage",
		"/tmp/GoNavi/updates/1.2.3/stage/mnt",
		"/tmp/GoNavi/updates/1.2.3/gonavi-update-macos.log",
		4242,
	)

	if !strings.Contains(script, `/usr/bin/osascript - "$APP_SRC"`) {
		t.Fatal("admin replace must pass `-` so osascript reads the AppleScript from stdin and the .app paths stay in argv")
	}
	// 裸形式（脚本体后面直接跟参数）会让 osascript 把第一个参数当脚本文件。
	for _, line := range strings.Split(script, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "/usr/bin/osascript") {
			continue
		}
		if !strings.Contains(trimmed, "osascript - ") {
			t.Fatalf("every osascript invocation must pass `-` before arguments, got: %s", trimmed)
		}
	}
	// 六个 argv 都要在内置脚本里被真正读取，否则授权命令会拼错路径。
	for _, item := range []string{
		"set srcPath to item 1 of argv",
		"set dstPath to item 2 of argv",
		"set tmpPath to item 3 of argv",
		"set bakPath to item 4 of argv",
		"set binRel to item 5 of argv",
		"set logPath to item 6 of argv",
	} {
		if !strings.Contains(script, item) {
			t.Fatalf("admin replace AppleScript missing %q", item)
		}
	}
}

// 挪走旧包失败时必须中止，否则新包会被塞进旧包内部，而旧包可执行文件仍在原位，
// 后续存在性校验照样通过 —— 表现为「更新成功但版本没变」。
func TestBuildMacScriptAbortsWhenExistingAppCannotBeMovedAside(t *testing.T) {
	script := buildMacScript(
		"/tmp/pkg.dmg",
		"/Applications/GoNavi.app",
		"/tmp/updates",
		"/tmp/updates/stage",
		"/tmp/updates/stage/mnt",
		"/tmp/updates/install.log",
		1,
	)

	if strings.Contains(script, "\n    /bin/mv \"$TARGET_APP\" \"$BACKUP_APP\" >>\"$LOG_FILE\" 2>&1\n") {
		t.Fatal("moving the existing app aside must be checked; an unchecked mv lets the new bundle nest inside the old one")
	}
	if !strings.Contains(script, `if ! /bin/mv "$TARGET_APP" "$BACKUP_APP"`) {
		t.Fatal("expected a guarded mv-aside with failure handling")
	}
	// 每个失败分支都必须留日志再退出，主进程据此保留窗口并显示失败。
	failures := strings.Count(script, "fail_update \"")
	if failures < 5 {
		t.Fatalf("expected every terminal failure path to record a failure, found %d fail_update calls", failures)
	}
	for _, exitPath := range []string{
		"fail_update \"无法从安装包中解出应用",
		"fail_update \"无权限替换应用",
		"fail_update \"替换后目标应用",
		"fail_update \"应用已替换但自动重启失败",
	} {
		if !strings.Contains(script, exitPath) {
			t.Fatalf("missing failure log %q", exitPath)
		}
	}
	// 失败日志必须在删除 updates 目录之前写入，否则用户拿不到原因。
	rmIdx := strings.Index(script, `/bin/rm -rf "$UPDATES_DIR"`)
	lastNotify := strings.LastIndex(script, "fail_update \"")
	if rmIdx < 0 || lastNotify < 0 || lastNotify > rmIdx {
		t.Fatal("failure logs must be written before the updates directory is removed")
	}
}

func TestBuildMacScriptInstallsBeforeHostExitAndBarriersRelaunch(t *testing.T) {
	script := buildMacScript(
		"/tmp/GoNavi/updates/dev-abc/GoNavi-dev-abc-MacOS-Arm64.dmg",
		"/Applications/GoNavi.app",
		"/tmp/GoNavi/updates",
		"/tmp/GoNavi/updates/dev-abc/stage",
		"/tmp/GoNavi/updates/dev-abc/stage/mnt",
		"/tmp/GoNavi/updates/dev-abc/install.log",
		4242,
	)

	for _, token := range []string{
		`RESTART_PARENT_ARG="--gonavi-restart-parent-pid=${PID}"`,
		`open -n "$TARGET_APP" --args "$RESTART_PARENT_ARG"`,
	} {
		if !strings.Contains(script, token) {
			t.Fatalf("relaunch must wait for the old process to exit, missing %q", token)
		}
	}
	prepareIdx := strings.Index(script, "if ! prepare_app_source_from_package; then")
	replaceIdx := strings.Index(script, "if ! replace_app_direct; then")
	relaunchIdx := strings.Index(script, "if ! relaunch_app; then")
	if prepareIdx < 0 || replaceIdx < 0 || relaunchIdx < 0 || !(prepareIdx < replaceIdx && replaceIdx < relaunchIdx) {
		t.Fatalf("install must mount, replace, then relaunch before the host exits (prepare=%d replace=%d relaunch=%d)", prepareIdx, replaceIdx, relaunchIdx)
	}
}

func TestBuildMacScriptInstallsAndRelaunchesBeforeHostExit(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS update script integration only runs on darwin")
	}
	if _, err := exec.LookPath("/usr/bin/open"); err != nil {
		t.Skip("open is unavailable")
	}

	root := t.TempDir()
	updatesDir := filepath.Join(root, "updates")
	stagedDir := filepath.Join(updatesDir, "stage")
	mountDir := filepath.Join(stagedDir, "mnt")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	argFile := filepath.Join(root, "launch-args.txt")
	packagePath := filepath.Join(root, "GoNavi-test.zip")
	sourceApp := filepath.Join(root, "source", "GoNavi.app")
	if err := os.MkdirAll(filepath.Join(sourceApp, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceApp, "Contents", "Info.plist"), []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.gonavi.updateprobe</string>
<key>CFBundleName</key><string>GoNavi</string>
<key>CFBundleExecutable</key><string>GoNavi</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`), 0o644); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(sourceApp, "Contents", "MacOS", "GoNavi")
	if err := os.WriteFile(binary, []byte("#!/bin/bash\nprintf '%s\\n' \"$@\" > "+argFile+"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("/usr/bin/ditto", "-c", "-k", "--norsrc", filepath.Dir(sourceApp), packagePath).CombinedOutput(); err != nil {
		t.Fatalf("create test zip: %v\n%s", err, output)
	}

	targetApp := filepath.Join(root, "GoNavi.app")
	script := buildMacScript(packagePath, targetApp, updatesDir, stagedDir, mountDir, filepath.Join(stagedDir, "update.log"), os.Getpid())
	scriptPath := filepath.Join(stagedDir, "update.sh")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/bash", scriptPath)
	cmd.Dir = stagedDir
	if output, err := cmd.CombinedOutput(); err != nil {
		logPayload, _ := os.ReadFile(filepath.Join(stagedDir, "update.log"))
		t.Fatalf("run generated update script: %v\nstdout:\n%s\nlog:\n%s", err, output, logPayload)
	}

	installedBinary := filepath.Join(targetApp, "Contents", "MacOS", "GoNavi")
	payload, err := os.ReadFile(installedBinary)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), "#!/bin/bash") {
		t.Fatalf("target app was not replaced with the staged payload: %q", payload)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		payload, err = os.ReadFile(argFile)
		if err == nil && strings.Contains(string(payload), "--gonavi-restart-parent-pid=") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("relaunched app did not receive the parent barrier argument: %v", err)
}
