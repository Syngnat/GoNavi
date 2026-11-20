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
		Name:        "get_server_version",
		Description: "根据 connectionId 读取当前数据库的真实服务端版本。生成 SQL 前必须先看版本，避免对低版本库使用高版本语法。",
	}, service.GetServerVersion)

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
			Description: "执行 SQL；Redis 连接执行单条 Redis 命令，dbName 为 DB 编号。受 GoNavi「安全控制」约束：只读允许查询，读写允许普通数据写入，完全允许管理及未知命令。调用本工具即视为确认，不必再传 allowMutating。查询结果默认每结果集最多 50 行、上限 200。",
		}, service.ExecuteSQL)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "get_script_library",
			Description: "列出当前用户可见的 GoNavi 脚本和文件夹。返回脚本 ID、名称、说明、连接别名、输入别名和 revision，不返回完整源码；需要源码时调用 get_script。",
		}, service.GetScriptLibrary)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "get_script",
			Description: "读取一个已保存脚本的完整 JavaScript 源码、连接/输入绑定、写入开关和运行限制。运行脚本库脚本前先用它确认源码与 revision。",
		}, service.GetScript)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "save_script",
			Description: "创建或更新 GoNavi 脚本库脚本。更新已有脚本时必须传 get_script 返回的 revision；该工具只保存源码和绑定，不执行脚本。",
		}, service.SaveScript)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "list_script_input_sheets",
			Description: "读取 CSV/JSON/XLSX 输入文件的工作表名称。XLSX 有多个工作表时先调用它，再把选中的 sheetName 传给 run_script 的 inputs。",
		}, service.ListScriptInputSheets)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "prepare_script_write",
			Description: "为生产库写入脚本申请一次性 writeApprovalToken。仅当脚本 allowWrite=true 且绑定未受保护的生产连接时返回 token；非生产写或只读脚本不需要 token。",
		}, service.PrepareScriptWrite)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "run_script",
			Description: "启动 GoNavi 脚本工作台 JavaScript。支持 scriptId 或内联 script、连接别名、CSV/JSON/XLSX 输入、批大小、IN 分片、超时、调用次数、输出行数和内存限制。返回 runId 和运行快照；脚本可调用 gonavi.db.query、gonavi.db.execute、事务、gonavi.files 和 gonavi.output。只读安全等级禁止 allowWrite；读写等级禁止 DDL；完全等级才允许 DDL。",
		}, service.RunScript)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "get_script_run",
			Description: "读取脚本运行的当前状态、阶段、进度、最近日志、错误和输出流摘要。run_script 等待超时后用它继续轮询，直到状态为 succeeded/failed/cancelled/timed_out。",
		}, service.GetScriptRun)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "get_script_output",
			Description: "分页读取 gonavi.output 的输出行。先看 get_script_run 返回的 outputs，再按 outputIndex 取行；默认每页 50 行，最大 200。",
		}, service.GetScriptOutput)

		mcp.AddTool(server, &mcp.Tool{
			Name:        "cancel_script_run",
			Description: "取消仍在排队或运行的脚本。取消会停止后续数据库调用并返回最终运行快照。",
		}, service.CancelScriptRun)
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
