package mcpserver

import (
	"runtime/debug"
	"strings"

	"GoNavi-Wails/internal/requesttrace"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ServerOptions 控制 MCP server 对外暴露的工具范围。
type ServerOptions struct {
	// SchemaOnly 仅暴露连接、库表、字段、索引、外键、触发器和 DDL 工具，不注册 execute_sql。
	SchemaOnly bool
}

func NewServer(backend Backend) *mcp.Server {
	return NewServerWithOptions(backend, ServerOptions{})
}

func NewServerWithOptions(backend Backend, options ServerOptions) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "gonavi-ai",
		Version: implementationVersion(),
	}, nil)
	if traced, ok := backend.(interface {
		RequestTraceStore() *requesttrace.Store
	}); ok {
		server.AddReceivingMiddleware(newMCPRequestTraceMiddleware(traced.RequestTraceStore()))
	}

	service := NewService(backend)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_connections",
		Description: "列出当前 GoNavi 已保存的数据库连接，先调用它获取 connectionId。不会返回明文密码等敏感信息。",
	}, service.GetConnections)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_databases",
		Description: "根据 connectionId 获取数据库/Schema 列表。",
	}, service.GetDatabases)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_tables",
		Description: "根据 connectionId 和可选 dbName 获取表列表，并在返回结果的 views 字段附带视图列表。dbName 为空时优先使用保存连接里的默认数据库。",
	}, service.GetTables)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_views",
		Description: "根据 connectionId 和可选 dbName 获取视图列表。dbName 为空时优先使用保存连接里的默认数据库。",
	}, service.GetViews)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_objects",
		Description: "根据 connectionId 和可选 dbName 获取数据库对象清单，覆盖表、视图、触发器、函数、过程、序列、包、事件，以及消息队列类 topic/queue/exchange 等对象。",
	}, service.GetObjects)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_all_columns",
		Description: "根据 connectionId 和 dbName 获取该数据库下全部表的字段摘要，适合按字段反查表。",
	}, service.GetAllColumns)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_columns",
		Description: "根据 connectionId、可选 dbName、tableName 获取字段定义。",
	}, service.GetColumns)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_indexes",
		Description: "根据 connectionId、可选 dbName、tableName 获取索引定义。",
	}, service.GetIndexes)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_foreign_keys",
		Description: "根据 connectionId、可选 dbName、tableName 获取外键关系。",
	}, service.GetForeignKeys)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_triggers",
		Description: "根据 connectionId、可选 dbName、tableName 获取触发器定义。",
	}, service.GetTriggers)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_table_ddl",
		Description: "根据 connectionId、可选 dbName、tableName 获取建表或建视图语句。",
	}, service.GetTableDDL)

	if !options.SchemaOnly {
		mcp.AddTool(server, &mcp.Tool{
			Name:        "execute_sql",
			Description: "执行 SQL 并返回少量结果行（默认每结果集最多 50 行，上限 200）。适合探查样例数据，不适合大批量导出。执行范围受 GoNavi AI 设置中的安全控制约束；命中允许范围内的 DML/DDL 等非只读语句时，仍必须显式传 allowMutating=true。",
		}, service.ExecuteSQL)
	}

	return server
}

func implementationVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		version := strings.TrimSpace(info.Main.Version)
		if version != "" && version != "(devel)" {
			return version
		}
	}
	return "dev"
}
