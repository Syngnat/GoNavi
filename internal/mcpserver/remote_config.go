package mcpserver

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	defaultRemoteMCPPublicURL = "https://<你的域名或隧道地址>/mcp"
	defaultRemoteMCPServerID  = "gonavi"
	defaultRemoteMCPTokenHint = "<随机token>"
)

// RemoteMCPClientConfigOptions 描述给云端 Agent 生成远程 MCP 配置的参数。
type RemoteMCPClientConfigOptions struct {
	Client            string
	DisplayName       string
	URL               string
	Token             string
	ServerID          string
	LocalAddr         string
	Path              string
	GoNaviCommand     string
	StandaloneCommand string
	SchemaOnly        bool
}

// ParseRemoteMCPClientConfigOptions 解析 remote-config 模式参数。
func ParseRemoteMCPClientConfigOptions(args []string) (RemoteMCPClientConfigOptions, error) {
	options := RemoteMCPClientConfigOptions{
		Client:            "openclaw",
		URL:               strings.TrimSpace(os.Getenv("GONAVI_MCP_PUBLIC_URL")),
		Token:             strings.TrimSpace(os.Getenv("GONAVI_MCP_HTTP_TOKEN")),
		ServerID:          defaultRemoteMCPServerID,
		LocalAddr:         strings.TrimSpace(os.Getenv("GONAVI_MCP_HTTP_ADDR")),
		Path:              strings.TrimSpace(os.Getenv("GONAVI_MCP_HTTP_PATH")),
		GoNaviCommand:     "GoNavi.exe",
		StandaloneCommand: "gonavi-mcp-server",
		SchemaOnly:        parseBoolEnvDefault("GONAVI_MCP_SCHEMA_ONLY", true),
	}
	if options.URL == "" {
		options.URL = defaultRemoteMCPPublicURL
	}
	if options.Token == "" {
		options.Token = defaultRemoteMCPTokenHint
	}
	if options.LocalAddr == "" {
		options.LocalAddr = defaultStreamableHTTPAddr
	}
	if options.Path == "" {
		options.Path = defaultStreamableHTTPPath
	}

	fs := flag.NewFlagSet("gonavi-mcp-server remote-config", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&options.Client, "client", options.Client, "remote MCP client name, for example openclaw or hermans")
	fs.StringVar(&options.URL, "url", options.URL, "public Streamable HTTP MCP URL")
	fs.StringVar(&options.Token, "token", options.Token, "bearer token used by the remote MCP client")
	fs.StringVar(&options.ServerID, "server-id", options.ServerID, "MCP server id in generated config")
	fs.StringVar(&options.LocalAddr, "addr", options.LocalAddr, "local HTTP listen address for GoNavi")
	fs.StringVar(&options.Path, "path", options.Path, "local and public MCP path")
	fs.StringVar(&options.GoNaviCommand, "gonavi-command", options.GoNaviCommand, "GoNavi application command on Windows")
	fs.StringVar(&options.StandaloneCommand, "standalone-command", options.StandaloneCommand, "standalone gonavi-mcp-server command")
	fs.BoolVar(&options.SchemaOnly, "schema-only", options.SchemaOnly, "generate a schema-only remote MCP launch command without execute_sql")
	if err := fs.Parse(args); err != nil {
		return RemoteMCPClientConfigOptions{}, err
	}
	if fs.NArg() > 0 {
		return RemoteMCPClientConfigOptions{}, fmt.Errorf("未知 remote-config 参数: %s", strings.Join(fs.Args(), " "))
	}
	return normalizeRemoteMCPClientConfigOptions(options), nil
}

func normalizeRemoteMCPClientConfigOptions(options RemoteMCPClientConfigOptions) RemoteMCPClientConfigOptions {
	options.Client = strings.ToLower(strings.TrimSpace(options.Client))
	if options.Client == "" {
		options.Client = "remote-agent"
	}
	options.DisplayName = remoteMCPClientDisplayName(options.Client, options.DisplayName)
	options.URL = strings.TrimSpace(options.URL)
	if options.URL == "" {
		options.URL = defaultRemoteMCPPublicURL
	}
	options.Token = strings.TrimSpace(options.Token)
	if options.Token == "" {
		options.Token = defaultRemoteMCPTokenHint
	}
	options.ServerID = strings.TrimSpace(options.ServerID)
	if options.ServerID == "" {
		options.ServerID = defaultRemoteMCPServerID
	}
	options.LocalAddr = strings.TrimSpace(options.LocalAddr)
	if options.LocalAddr == "" {
		options.LocalAddr = defaultStreamableHTTPAddr
	}
	options.Path = strings.TrimSpace(options.Path)
	if options.Path == "" {
		options.Path = defaultStreamableHTTPPath
	}
	if !strings.HasPrefix(options.Path, "/") {
		options.Path = "/" + options.Path
	}
	options.GoNaviCommand = strings.TrimSpace(options.GoNaviCommand)
	if options.GoNaviCommand == "" {
		options.GoNaviCommand = "GoNavi.exe"
	}
	options.StandaloneCommand = strings.TrimSpace(options.StandaloneCommand)
	if options.StandaloneCommand == "" {
		options.StandaloneCommand = "gonavi-mcp-server"
	}
	return options
}

func remoteMCPClientDisplayName(client string, fallback string) string {
	if trimmed := strings.TrimSpace(fallback); trimmed != "" {
		return trimmed
	}
	switch strings.ToLower(strings.TrimSpace(client)) {
	case "openclaw":
		return "OpenClaw"
	case "hermans":
		return "Hermans"
	default:
		return "远程 Agent"
	}
}

// RenderRemoteMCPClientConfig 生成给远程 Agent 和 Windows 本机分别使用的配置文本。
func RenderRemoteMCPClientConfig(options RemoteMCPClientConfigOptions) (string, error) {
	normalized := normalizeRemoteMCPClientConfigOptions(options)
	config := map[string]any{
		"mcpServers": map[string]any{
			normalized.ServerID: map[string]any{
				"type": "streamable-http",
				"url":  normalized.URL,
				"headers": map[string]string{
					"Authorization": "Bearer " + normalized.Token,
				},
			},
		},
	}
	configJSON, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", fmt.Errorf("生成远程 MCP 配置失败: %w", err)
	}

	launch := remoteMCPHTTPLaunchCommand(normalized.GoNaviCommand, true, normalized.LocalAddr, normalized.Path, normalized.Token, normalized.SchemaOnly)
	standalone := remoteMCPHTTPLaunchCommand(normalized.StandaloneCommand, false, normalized.LocalAddr, normalized.Path, normalized.Token, normalized.SchemaOnly)
	lines := []string{
		fmt.Sprintf("GoNavi MCP 远程接入配置 - %s", normalized.DisplayName),
		"",
		"云端 Agent 配置（不要写数据库账号密码）：",
		string(configJSON),
		"",
		"Windows 本机启动 GoNavi MCP HTTP：",
		launch,
		"",
		"独立 MCP Server 启动方式：",
		standalone,
		"",
		"验证顺序：",
		fmt.Sprintf("1. Windows 本机访问 http://%s/healthz，确认返回 ok。", normalized.LocalAddr),
		fmt.Sprintf("2. %s 中配置上面的 Streamable HTTP MCP，URL 指向公网/隧道后的 %s。", normalized.DisplayName, normalized.URL),
		"3. 先调用 get_connections 获取 connectionId，再调用 get_server_version / get_databases / get_objects / get_tables / get_views / get_columns / get_table_ddl。",
		"4. 如需脚本能力，先去启动参数中的 --schema-only，再调用 get_script_library / get_script 查看绑定，并用 run_script 执行；长任务用 get_script_run / get_script_output 轮询和分页。",
		"",
		"安全边界：",
		"- 数据库连接、账号和密码继续保存在 Windows GoNavi。",
		"- 云端 Agent 只保存 MCP URL 和 Bearer Token。",
		"- 默认 schema-only 模式不会注册 execute_sql 与脚本执行工具，适合只给 OpenClaw/Hermans 读取对象与结构元数据。",
		"- 如明确去掉 --schema-only 开放 execute_sql 与脚本工具，它们共用 AI 安全控制：只读禁止脚本写入，读写允许 DML 但禁止 DDL，完全才允许 DDL。调用 execute_sql 即视为确认，不必再传 allowMutating。",
	}
	return strings.Join(lines, "\n") + "\n", nil
}

// WriteRemoteMCPClientConfig 把远程 MCP 配置写入指定输出，供 CLI 模式复用。
func WriteRemoteMCPClientConfig(w io.Writer, args []string) error {
	if w == nil {
		w = io.Discard
	}
	options, err := ParseRemoteMCPClientConfigOptions(args)
	if err != nil {
		return err
	}
	text, err := RenderRemoteMCPClientConfig(options)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, text)
	return err
}

func remoteMCPHTTPLaunchCommand(command string, appSubcommand bool, addr string, path string, token string, schemaOnly bool) string {
	parts := []string{
		command,
	}
	if appSubcommand {
		parts = append(parts, "mcp-server")
	}
	parts = append(parts, "http", "--addr", addr, "--path", path, "--token", token)
	if schemaOnly {
		parts = append(parts, "--schema-only")
	}
	for index, part := range parts {
		parts[index] = quoteCommandPart(part)
	}
	return strings.Join(parts, " ")
}

func quoteCommandPart(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return `""`
	}
	if !strings.ContainsAny(trimmed, " \t\"") {
		return trimmed
	}
	return `"` + strings.ReplaceAll(trimmed, `"`, `\"`) + `"`
}
