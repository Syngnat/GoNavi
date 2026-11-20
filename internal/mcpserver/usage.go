package mcpserver

import "io"

// MCP 子模式的用法文本。flag 包自己也会打用法，但它把输出改成了丢弃
// （见 ParseHTTPServerOptions / ParseRemoteMCPClientConfigOptions），因此
// 帮助文本必须由调用方补上，否则 -h/--help 只会留下一屏空白。
const (
	appMCPServerUsage = `用法：gonavi mcp-server [stdio|http|remote-config] [选项]

子模式：
  stdio            （默认）标准输入输出传输，供本机 Agent 以子进程方式拉起
  http             Streamable HTTP 传输，供容器或远程 Agent 接入
  remote-config    生成远程 MCP 客户端配置片段，写到标准输出

不带子模式时等同于 stdio。各子模式的选项见各自的 --help。
`

	mcpHTTPUsage = `用法：gonavi mcp-server http [选项]

选项：
  --addr <主机:端口>     监听地址，默认 127.0.0.1:8765
                        也可用环境变量 GONAVI_MCP_HTTP_ADDR 指定
  --path <路径>          MCP 端点路径，默认 /mcp
  --token <令牌>        远程客户端必须携带的 Bearer 令牌
                        也可用环境变量 GONAVI_MCP_HTTP_TOKEN 指定
  --json-response       尽量返回 application/json 而非事件流
  --schema-only         只暴露库表结构工具，不提供 execute_sql 与脚本执行工具
  --allow-non-loopback  允许监听非回环地址（仅供显式容器部署）
`

	mcpRemoteConfigUsage = `用法：gonavi mcp-server remote-config [选项]

选项：
  --client <名称>              目标客户端，例如 openclaw、hermans
  --url <公开地址>             公开的 Streamable HTTP MCP 地址
  --token <令牌>               远程客户端使用的 Bearer 令牌
  --server-id <标识>           MCP 服务在生成配置中的标识
  --addr <主机:端口>           GoNavi 本地监听地址
  --path <路径>                本地与公开的 MCP 路径
  --gonavi-command <命令>      Windows 上的 GoNavi 可执行文件名
  --standalone-command <命令>  独立 gonavi-mcp-server 可执行文件名
  --schema-only                生成不含 execute_sql 与脚本执行工具的配置

生成的配置片段写到标准输出。
`
)

// WriteAppMCPServerUsage 输出 mcp-server 的用法，供 -h/--help 使用。
func WriteAppMCPServerUsage(w io.Writer) {
	writeUsage(w, appMCPServerUsage)
}

// WriteHTTPServerUsage 输出 http 子模式的用法，供 -h/--help 使用。
func WriteHTTPServerUsage(w io.Writer) {
	writeUsage(w, mcpHTTPUsage)
}

// WriteRemoteMCPClientConfigUsage 输出 remote-config 子模式的用法。
func WriteRemoteMCPClientConfigUsage(w io.Writer) {
	writeUsage(w, mcpRemoteConfigUsage)
}

func writeUsage(w io.Writer, usage string) {
	if w == nil {
		return
	}
	_, _ = io.WriteString(w, usage)
}
