package jvm

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

var errJVMFixtureToolchainUnavailable = errors.New("JDK toolchain unavailable")

// The full backend suite can leave the Linux runner CPU-constrained while
// starting a JVM. Keep a finite deadline, but do not mistake a slow JVM
// startup for an unusable JDK after the previous five-second deadline.
const jvmFixtureToolVersionTimeout = 30 * time.Second

var jvmFixtureVersionPattern = regexp.MustCompile(`(?i)(?:java|openjdk|javac)(?:\s+version)?\s+"?([0-9]+)(?:\.([0-9]+))?`)

type jvmFixtureToolchain struct {
	JavaBin      string
	JavacBin     string
	JarBin       string
	JavaVersion  string
	JavacVersion string
	Major        int
}

func (toolchain jvmFixtureToolchain) summary() string {
	return fmt.Sprintf(
		"java=%s (%s), javac=%s (%s), major=%d",
		toolchain.JavaBin,
		compactJVMFixtureVersion(toolchain.JavaVersion),
		toolchain.JavacBin,
		compactJVMFixtureVersion(toolchain.JavacVersion),
		toolchain.Major,
	)
}

type jvmFixtureToolchainResolver struct {
	getenv   func(string) string
	lookPath func(string) (string, error)
	stat     func(string) (os.FileInfo, error)
	version  func(context.Context, string) (string, int, error)
}

func defaultJVMFixtureToolchainResolver() jvmFixtureToolchainResolver {
	return jvmFixtureToolchainResolver{
		getenv:   os.Getenv,
		lookPath: exec.LookPath,
		stat:     os.Stat,
		version:  readJVMFixtureToolVersion,
	}
}

func requireJVMFixtureToolchain(t *testing.T, requireJar bool) jvmFixtureToolchain {
	t.Helper()

	toolchain, err := defaultJVMFixtureToolchainResolver().resolve(context.Background(), requireJar)
	if errors.Is(err, errJVMFixtureToolchainUnavailable) {
		t.Skipf("一致 JDK 工具链不可用，跳过真实 JVM fixture 测试: %v", err)
	}
	if err != nil {
		t.Fatalf("解析 JVM fixture JDK 工具链失败: %v", err)
	}
	return toolchain
}

func (resolver jvmFixtureToolchainResolver) resolve(ctx context.Context, requireJar bool) (jvmFixtureToolchain, error) {
	if javaHome := strings.TrimSpace(resolver.getenv("JAVA_HOME")); javaHome != "" {
		binDir := filepath.Join(javaHome, "bin")
		if toolchain, ok, err := resolver.resolveBinDir(ctx, binDir, requireJar); ok || err != nil {
			return toolchain, err
		}
	}

	javacBin, err := resolver.lookPath(jvmFixtureBinaryName("javac"))
	if err != nil {
		return jvmFixtureToolchain{}, fmt.Errorf("%w: javac not found on PATH: %v", errJVMFixtureToolchainUnavailable, err)
	}
	binDir := filepath.Dir(javacBin)
	if toolchain, ok, resolveErr := resolver.resolveBinDir(ctx, binDir, requireJar); ok || resolveErr != nil {
		return toolchain, resolveErr
	}

	javaBin, err := resolver.lookPath(jvmFixtureBinaryName("java"))
	if err != nil {
		return jvmFixtureToolchain{}, fmt.Errorf("%w: java not found beside %s or on PATH: %v", errJVMFixtureToolchainUnavailable, javacBin, err)
	}
	jarBin := ""
	if requireJar {
		return jvmFixtureToolchain{}, fmt.Errorf("JDK toolchain beside %s does not contain %s", javacBin, jvmFixtureBinaryName("jar"))
	}
	return resolver.validate(ctx, javaBin, javacBin, jarBin)
}

func (resolver jvmFixtureToolchainResolver) resolveBinDir(ctx context.Context, binDir string, requireJar bool) (jvmFixtureToolchain, bool, error) {
	javaBin := filepath.Join(binDir, jvmFixtureBinaryName("java"))
	javacBin := filepath.Join(binDir, jvmFixtureBinaryName("javac"))
	if !resolver.isFile(javaBin) || !resolver.isFile(javacBin) {
		return jvmFixtureToolchain{}, false, nil
	}
	jarBin := ""
	if requireJar {
		jarBin = filepath.Join(binDir, jvmFixtureBinaryName("jar"))
		if !resolver.isFile(jarBin) {
			return jvmFixtureToolchain{}, false, nil
		}
	}
	toolchain, err := resolver.validate(ctx, javaBin, javacBin, jarBin)
	return toolchain, true, err
}

func (resolver jvmFixtureToolchainResolver) isFile(path string) bool {
	info, err := resolver.stat(path)
	return err == nil && !info.IsDir()
}

func (resolver jvmFixtureToolchainResolver) validate(ctx context.Context, javaBin, javacBin, jarBin string) (jvmFixtureToolchain, error) {
	javaVersion, javaMajor, err := resolver.version(ctx, javaBin)
	if err != nil {
		return jvmFixtureToolchain{}, fmt.Errorf("read java version from %s: %w", javaBin, err)
	}
	javacVersion, javacMajor, err := resolver.version(ctx, javacBin)
	if err != nil {
		return jvmFixtureToolchain{}, fmt.Errorf("read javac version from %s: %w", javacBin, err)
	}
	if javaMajor != javacMajor {
		return jvmFixtureToolchain{}, fmt.Errorf(
			"java/javac major version mismatch: java=%s (%s, major=%d), javac=%s (%s, major=%d)",
			javaBin,
			compactJVMFixtureVersion(javaVersion),
			javaMajor,
			javacBin,
			compactJVMFixtureVersion(javacVersion),
			javacMajor,
		)
	}
	return jvmFixtureToolchain{
		JavaBin:      javaBin,
		JavacBin:     javacBin,
		JarBin:       jarBin,
		JavaVersion:  javaVersion,
		JavacVersion: javacVersion,
		Major:        javaMajor,
	}, nil
}

func jvmFixtureBinaryName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func readJVMFixtureToolVersion(parent context.Context, binary string) (string, int, error) {
	ctx, cancel := context.WithTimeout(parent, jvmFixtureToolVersionTimeout)
	defer cancel()

	var lastText string
	var lastErr error
	for _, argument := range []string{"--version", "-version"} {
		output, runErr := exec.CommandContext(ctx, binary, argument).CombinedOutput()
		text := strings.TrimSpace(string(output))
		lastText = text
		lastErr = runErr

		major, parseErr := parseJVMFixtureMajorVersion(text)
		if parseErr == nil {
			// Some Windows Java launchers return exit status 1 while still
			// emitting a valid version string. The fixture only needs a
			// consistent toolchain, so the parsed version is authoritative.
			return text, major, nil
		}
		if runErr == nil {
			return text, 0, parseErr
		}
	}
	if lastErr != nil {
		return lastText, 0, fmt.Errorf("%w; output: %s", lastErr, nonEmptyJVMFixtureText(lastText, "<empty>"))
	}
	return lastText, 0, fmt.Errorf("unrecognized Java version output: %q", compactJVMFixtureVersion(lastText))
}

func parseJVMFixtureMajorVersion(output string) (int, error) {
	matches := jvmFixtureVersionPattern.FindStringSubmatch(output)
	if len(matches) < 2 {
		return 0, fmt.Errorf("unrecognized Java version output: %q", compactJVMFixtureVersion(output))
	}
	major, err := strconv.Atoi(matches[1])
	if err != nil {
		return 0, fmt.Errorf("parse Java major version from %q: %w", matches[1], err)
	}
	if major == 1 && len(matches) > 2 && matches[2] != "" {
		major, err = strconv.Atoi(matches[2])
		if err != nil {
			return 0, fmt.Errorf("parse legacy Java major version from %q: %w", matches[2], err)
		}
	}
	return major, nil
}

func compactJVMFixtureVersion(version string) string {
	return strings.Join(strings.Fields(version), " ")
}

func nonEmptyJVMFixtureText(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func compileJVMFixture(t *testing.T, toolchain jvmFixtureToolchain, label, classesDir string, javaFiles []string) {
	t.Helper()

	compileArgs := append([]string{"-encoding", "UTF-8", "-d", classesDir}, javaFiles...)
	output, err := exec.Command(toolchain.JavacBin, compileArgs...).CombinedOutput()
	if err != nil {
		t.Fatalf("compile %s fixture failed: %v; output: %s; toolchain: %s", label, err, nonEmptyJVMFixtureText(strings.TrimSpace(string(output)), "<empty>"), toolchain.summary())
	}
}

type jvmFixtureCommand struct {
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	stderr   bytes.Buffer
	waitOnce sync.Once
	waitErr  error
}

func startJVMFixtureCommand(t *testing.T, toolchain jvmFixtureToolchain, label string, args ...string) (*jvmFixtureCommand, io.ReadCloser) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, toolchain.JavaBin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatalf("%s fixture stdout pipe failed: %v; toolchain: %s", label, err, toolchain.summary())
	}
	process := &jvmFixtureCommand{cmd: cmd, cancel: cancel}
	cmd.Stderr = &process.stderr
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("start %s fixture failed: %v; toolchain: %s", label, err, toolchain.summary())
	}
	t.Cleanup(func() {
		process.stopAndWait()
	})
	return process, stdout
}

func (process *jvmFixtureCommand) stopAndWait() error {
	process.cancel()
	process.waitOnce.Do(func() {
		process.waitErr = process.cmd.Wait()
	})
	return process.waitErr
}

func waitForJVMFixtureReady(t *testing.T, process *jvmFixtureCommand, stdout io.Reader, toolchain jvmFixtureToolchain, label, expectedLine string, timeout time.Duration) {
	t.Helper()

	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if strings.TrimSpace(scanner.Text()) == expectedLine {
				ready <- nil
				return
			}
		}
		if err := scanner.Err(); err != nil {
			ready <- fmt.Errorf("readiness read failed: %w", err)
			return
		}
		ready <- io.EOF
	}()

	select {
	case err := <-ready:
		if err != nil {
			waitErr := process.stopAndWait()
			t.Fatalf("%v", formatJVMFixtureStartError(label, err, waitErr, process.stderr.String(), toolchain))
		}
	case <-time.After(timeout):
		waitErr := process.stopAndWait()
		t.Fatalf("%v", formatJVMFixtureStartError(label, fmt.Errorf("did not become ready within %s", timeout), waitErr, process.stderr.String(), toolchain))
	}
}

func formatJVMFixtureStartError(label string, cause, waitErr error, stderr string, toolchain jvmFixtureToolchain) error {
	exitStatus := "success"
	if waitErr != nil {
		exitStatus = waitErr.Error()
	}
	return fmt.Errorf(
		"%s fixture readiness failed: %w; exit status: %s; stderr: %s; toolchain: %s",
		label,
		cause,
		exitStatus,
		nonEmptyJVMFixtureText(strings.TrimSpace(stderr), "<empty>"),
		toolchain.summary(),
	)
}

func TestJVMFixtureToolchainUsesJavaBesideJavac(t *testing.T) {
	binDir := t.TempDir()
	javacBin := filepath.Join(binDir, jvmFixtureBinaryName("javac"))
	siblingJava := filepath.Join(binDir, jvmFixtureBinaryName("java"))
	pathJava8 := filepath.Join(t.TempDir(), jvmFixtureBinaryName("java"))
	for _, path := range []string{javacBin, siblingJava, pathJava8} {
		if err := os.WriteFile(path, []byte("fixture"), 0o755); err != nil {
			t.Fatalf("write fake JVM tool %s: %v", path, err)
		}
	}

	resolver := fakeJVMFixtureToolchainResolver(t, "", map[string]string{
		jvmFixtureBinaryName("javac"): javacBin,
		jvmFixtureBinaryName("java"):  pathJava8,
	}, map[string]struct {
		version string
		major   int
	}{
		javacBin:    {version: "javac 17.0.15", major: 17},
		siblingJava: {version: `openjdk version "17.0.15"`, major: 17},
		pathJava8:   {version: `java version "1.8.0_431"`, major: 8},
	})

	toolchain, err := resolver.resolve(context.Background(), false)
	if err != nil {
		t.Fatalf("resolve() error = %v", err)
	}
	if toolchain.JavaBin != siblingJava || toolchain.JavacBin != javacBin || toolchain.Major != 17 {
		t.Fatalf("resolve() = %#v, want javac sibling toolchain", toolchain)
	}
}

func TestJVMFixtureToolchainPrefersCompleteJavaHome(t *testing.T) {
	javaHome := t.TempDir()
	binDir := filepath.Join(javaHome, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("create fake JAVA_HOME bin: %v", err)
	}
	javaBin := filepath.Join(binDir, jvmFixtureBinaryName("java"))
	javacBin := filepath.Join(binDir, jvmFixtureBinaryName("javac"))
	jarBin := filepath.Join(binDir, jvmFixtureBinaryName("jar"))
	for _, path := range []string{javaBin, javacBin, jarBin} {
		if err := os.WriteFile(path, []byte("fixture"), 0o755); err != nil {
			t.Fatalf("write fake JAVA_HOME tool %s: %v", path, err)
		}
	}

	resolver := fakeJVMFixtureToolchainResolver(t, javaHome, map[string]string{}, map[string]struct {
		version string
		major   int
	}{
		javaBin:  {version: `openjdk version "21.0.7"`, major: 21},
		javacBin: {version: "javac 21.0.7", major: 21},
	})

	toolchain, err := resolver.resolve(context.Background(), true)
	if err != nil {
		t.Fatalf("resolve() error = %v", err)
	}
	if toolchain.JavaBin != javaBin || toolchain.JavacBin != javacBin || toolchain.JarBin != jarBin || toolchain.Major != 21 {
		t.Fatalf("resolve() = %#v, want JAVA_HOME toolchain", toolchain)
	}
}

func TestJVMFixtureToolchainRejectsMismatchedFallback(t *testing.T) {
	binDir := t.TempDir()
	javacBin := filepath.Join(binDir, jvmFixtureBinaryName("javac"))
	pathJava8 := filepath.Join(t.TempDir(), jvmFixtureBinaryName("java"))
	for _, path := range []string{javacBin, pathJava8} {
		if err := os.WriteFile(path, []byte("fixture"), 0o755); err != nil {
			t.Fatalf("write fake JVM tool %s: %v", path, err)
		}
	}

	resolver := fakeJVMFixtureToolchainResolver(t, "", map[string]string{
		jvmFixtureBinaryName("javac"): javacBin,
		jvmFixtureBinaryName("java"):  pathJava8,
	}, map[string]struct {
		version string
		major   int
	}{
		javacBin:  {version: "javac 17.0.15", major: 17},
		pathJava8: {version: `java version "1.8.0_431"`, major: 8},
	})

	_, err := resolver.resolve(context.Background(), false)
	if err == nil || !strings.Contains(err.Error(), "major version mismatch") || !strings.Contains(err.Error(), "major=8") || !strings.Contains(err.Error(), "major=17") {
		t.Fatalf("resolve() error = %v, want explicit version mismatch", err)
	}
}

func TestParseJVMFixtureMajorVersion(t *testing.T) {
	cases := map[string]int{
		`java version "1.8.0_431"`:  8,
		`openjdk version "17.0.15"`: 17,
		`javac 21.0.7`:              21,
	}
	for output, want := range cases {
		if got, err := parseJVMFixtureMajorVersion(output); err != nil || got != want {
			t.Fatalf("parseJVMFixtureMajorVersion(%q) = %d, %v; want %d", output, got, err, want)
		}
	}
}

func TestFormatJVMFixtureStartErrorIncludesDiagnostics(t *testing.T) {
	toolchain := jvmFixtureToolchain{
		JavaBin:      `C:\jdk-17\bin\java.exe`,
		JavacBin:     `C:\jdk-17\bin\javac.exe`,
		JavaVersion:  `openjdk version "17.0.15"`,
		JavacVersion: "javac 17.0.15",
		Major:        17,
	}
	err := formatJVMFixtureStartError("endpoint", io.EOF, errors.New("exit status 1"), "UnsupportedClassVersionError", toolchain)
	for _, want := range []string{"endpoint", "EOF", "exit status 1", "UnsupportedClassVersionError", "java.exe", "javac.exe", "17.0.15"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("diagnostic error %q missing %q", err, want)
		}
	}
}

func fakeJVMFixtureToolchainResolver(t *testing.T, javaHome string, paths map[string]string, versions map[string]struct {
	version string
	major   int
}) jvmFixtureToolchainResolver {
	t.Helper()
	return jvmFixtureToolchainResolver{
		getenv: func(name string) string {
			if name == "JAVA_HOME" {
				return javaHome
			}
			return ""
		},
		lookPath: func(name string) (string, error) {
			if path := paths[name]; path != "" {
				return path, nil
			}
			return "", exec.ErrNotFound
		},
		stat: os.Stat,
		version: func(_ context.Context, binary string) (string, int, error) {
			version, ok := versions[binary]
			if !ok {
				return "", 0, fmt.Errorf("unexpected version lookup: %s", binary)
			}
			return version.version, version.major, nil
		},
	}
}
