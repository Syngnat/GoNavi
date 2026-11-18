package webserver

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

// captureStdout 临时接管 os.Stdout，返回读取已写内容的函数与恢复函数。
// Run 直接写 os.Stdout（进程级 fd），无法注入 io.Writer，只能这样观测。
func captureStdout(t *testing.T) (func() string, func()) {
	t.Helper()

	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stdout pipe: %v", err)
	}
	os.Stdout = writer

	drained := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(reader)
		drained <- string(data)
	}()

	restore := func() {
		os.Stdout = original
		_ = writer.Close()
	}
	return func() string {
		_ = writer.Close()
		output := <-drained
		_ = reader.Close()
		return output
	}, restore
}

// 日志默认只写文件，终端横幅是用户确认「服务是否就绪」和「日志在哪」的唯一
// 线索。这里锁定三种形态，防止横幅被误删或退化成污染 stdout。
func TestWriteStartupBannerRendersLoopbackForWildcardBind(t *testing.T) {
	cases := []struct {
		name    string
		addr    string
		wantURL string
	}{
		{name: "回环地址原样展示", addr: "127.0.0.1:34116", wantURL: "http://127.0.0.1:34116"},
		// 0.0.0.0 与 :: 不能直接给浏览器打开，必须换算成回环地址。
		{name: "通配 IPv4 换成回环", addr: "0.0.0.0:34116", wantURL: "http://127.0.0.1:34116"},
		{name: "通配 IPv6 换成回环", addr: "[::]:34116", wantURL: "http://127.0.0.1:34116"},
		{name: "空主机换成回环", addr: ":34116", wantURL: "http://127.0.0.1:34116"},
		{name: "IPv6 回环保留方括号", addr: "[::1]:34116", wantURL: "http://[::1]:34116"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var console bytes.Buffer
			server := &Server{options: Options{Addr: testCase.addr, Console: &console}}

			server.writeStartupBanner(testCase.addr)

			output := console.String()
			if !strings.Contains(output, testCase.wantURL) {
				t.Fatalf("banner = %q, want it to contain %q", output, testCase.wantURL)
			}
			// 日志路径必须出现，否则用户仍然不知道失败原因去哪里查。
			if !strings.Contains(output, "日志：") {
				t.Fatalf("banner = %q, want it to contain the log path hint", output)
			}
		})
	}
}

// 程序化调用方（测试、内嵌运行时）不设 Console，此时必须完全不写终端。
func TestWriteStartupBannerIsSilentWithoutConsole(t *testing.T) {
	server := &Server{options: Options{Addr: "127.0.0.1:34116"}}
	// 未设置 Console 时不应 panic，也不应有任何副作用。
	server.writeStartupBanner("127.0.0.1:34116")

	var nilServer *Server
	nilServer.writeStartupBanner("127.0.0.1:34116")
}

// Run() 是唯一把横幅接到 stderr 的入口：横幅走 stderr，stdout 留给 CLI 的
// 机器可读输出（JSONL），两者不能混。
func TestParseOptionsLeavesConsoleUnsetForProgrammaticCallers(t *testing.T) {
	options, err := ParseOptions([]string{"--addr", "127.0.0.1:34116"})
	if err != nil {
		t.Fatalf("ParseOptions() error = %v", err)
	}
	if options.Console != nil {
		t.Fatalf("ParseOptions() Console = %v, want nil so Run owns the terminal wiring", options.Console)
	}
}

// -h/--help 必须走 stdout 并正常返回，不能退化成「空屏 + 非零退出」：
// flag 包的用法输出在 ParseOptions 里被丢弃，帮助文本只能由 Run 补上。
func TestRunPrintsUsageForHelpFlag(t *testing.T) {
	for _, arg := range []string{"-h", "--help"} {
		t.Run(arg, func(t *testing.T) {
			stdout, restore := captureStdout(t)
			defer restore()

			// assetFS 传 nil 是刻意的：帮助路径必须在触碰监听与前端资源之前
			// 就返回，否则「看用法」也要先起一遍服务。
			if err := Run(t.Context(), nil, []string{arg}); err != nil {
				t.Fatalf("Run(%q) error = %v, want nil", arg, err)
			}

			output := stdout()
			if !strings.Contains(output, "gonavi web-server") {
				t.Fatalf("stdout = %q, want the web-server usage", output)
			}
			if !strings.Contains(output, "--addr") {
				t.Fatalf("stdout = %q, want the --addr option documented", output)
			}
		})
	}
}

// 未知参数仍必须是错误：它不能被 --help 的分支顺带吞掉。
func TestRunRejectsUnknownFlag(t *testing.T) {
	stdout, restore := captureStdout(t)
	defer restore()

	err := Run(t.Context(), nil, []string{"--bogus"})
	if err == nil {
		t.Fatal("Run(--bogus) error = nil, want a parse error")
	}
	if got := stdout(); got != "" {
		t.Fatalf("stdout = %q, want empty for a rejected flag", got)
	}
}

func TestWriteStartupBannerLeadsWithSetupURL(t *testing.T) {
	t.Setenv("GONAVI_WEB_PASSWORD", "")
	t.Setenv("GONAVI_WEB_SETUP_TOKEN", "gate-token")
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager: %v", err)
	}
	var console bytes.Buffer
	server := &Server{
		options: Options{Addr: "0.0.0.0:34116", Console: &console},
		auth:    manager,
	}

	server.writeStartupBanner("0.0.0.0:34116")

	output := console.String()
	wantURL := "http://127.0.0.1:34116/setup?setup=gate-token"
	if !strings.Contains(output, "首次初始化请打开："+wantURL) {
		t.Fatalf("banner = %q, want the setup URL as the only link to open", output)
	}
	if strings.Contains(output, "已启动：http://") {
		t.Fatalf("banner = %q, want no bare startup URL while setup is required", output)
	}
}
