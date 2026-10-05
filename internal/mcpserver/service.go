package mcpserver

import (
	"GoNavi-Wails/internal/connection"
)

const (
	// 结果行数上限只为避免撑爆 Agent 上下文，不是「只能查询」。
	defaultMaxRowsPerResult = 50
	maxRowsPerResultLimit   = 200
	redactedOpaqueTarget    = "opaque-connection-string-configured"
)

type Service struct {
	backend Backend
}

func NewService(backend Backend) *Service {
	return &Service{backend: backend}
}

type emptyArgs struct{}

type connectionIDArgs struct {
	ConnectionID string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
}

type databaseArgs struct {
	ConnectionID string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName       string `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
}

type objectsArgs struct {
	ConnectionID string   `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName       string   `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
	ObjectTypes  []string `json:"objectTypes,omitempty" jsonschema:"可选对象类型过滤，例如 table、view、function、procedure、package、queue、topic、exchange。为空返回全部支持对象"`
}

type tableArgs struct {
	ConnectionID string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName       string `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
	TableName    string `json:"tableName" jsonschema:"目标表或视图名称"`
}

type executeSQLArgs struct {
	ConnectionID     string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName           string `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
	SQL              string `json:"sql" jsonschema:"待执行的 SQL 文本，可以包含多条语句"`
	AllowMutating    bool   `json:"allowMutating,omitempty" jsonschema:"兼容旧客户端的可选字段。安全控制已允许的写语句不再要求传 true；调用 execute_sql 即视为确认"`
	MaxRowsPerResult int    `json:"maxRowsPerResult,omitempty" jsonschema:"每个结果集最多返回多少行。默认 50，最大 200，只限制返回给 Agent 的行数，不限制可执行的 SQL 类型。达到上限后立即停止读取，剩余行不返回；多语句查询中某条语句达到上限时，后续语句不再返回结果（逐条执行路径中后续语句将不执行；原生多语句批次中的语句仍会在服务端全部执行）"`
}

type connectionDescriptor struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Host            string `json:"host,omitempty"`
	Port            int    `json:"port,omitempty"`
	Database        string `json:"database,omitempty"`
	Driver          string `json:"driver,omitempty"`
	Topology        string `json:"topology,omitempty"`
	Target          string `json:"target,omitempty"`
	UseSSH          bool   `json:"useSSH,omitempty"`
	UseProxy        bool   `json:"useProxy,omitempty"`
	UseHTTPTunnel   bool   `json:"useHttpTunnel,omitempty"`
	DefaultDatabase string `json:"defaultDatabase,omitempty"`
}

type getConnectionsResult struct {
	Connections []connectionDescriptor `json:"connections"`
}

type getDatabasesResult struct {
	ConnectionID string   `json:"connectionId"`
	Databases    []string `json:"databases"`
}

type getTablesResult struct {
	ConnectionID string   `json:"connectionId"`
	DBName       string   `json:"dbName,omitempty"`
	Tables       []string `json:"tables"`
	Views        []string `json:"views"`
	Message      string   `json:"message,omitempty"`
	Partial      bool     `json:"partial,omitempty"`
	Warnings     []string `json:"warnings,omitempty"`
	Retryable    bool     `json:"retryable,omitempty"`
	Truncated    bool     `json:"truncated,omitempty"`
	ScannedCount int      `json:"scannedCount,omitempty"`
}

type getViewsResult struct {
	ConnectionID string   `json:"connectionId"`
	DBName       string   `json:"dbName,omitempty"`
	Views        []string `json:"views"`
}

type getObjectsResult struct {
	ConnectionID      string                      `json:"connectionId"`
	DBName            string                      `json:"dbName,omitempty"`
	Objects           []connection.DatabaseObject `json:"objects"`
	Message           string                      `json:"message,omitempty"`
	Partial           bool                        `json:"partial,omitempty"`
	Warnings          []string                    `json:"warnings,omitempty"`
	FailedObjectTypes []string                    `json:"failedObjectTypes,omitempty"`
	Retryable         bool                        `json:"retryable,omitempty"`
	Truncated         bool                        `json:"truncated,omitempty"`
	ScannedCount      int                         `json:"scannedCount,omitempty"`
}

type getAllColumnsResult struct {
	ConnectionID string                                 `json:"connectionId"`
	DBName       string                                 `json:"dbName,omitempty"`
	Columns      []connection.ColumnDefinitionWithTable `json:"columns"`
	Message      string                                 `json:"message,omitempty"`
	Partial      bool                                   `json:"partial,omitempty"`
	Warnings     []string                               `json:"warnings,omitempty"`
}

type getColumnsResult struct {
	ConnectionID string                        `json:"connectionId"`
	DBName       string                        `json:"dbName,omitempty"`
	TableName    string                        `json:"tableName"`
	Columns      []connection.ColumnDefinition `json:"columns"`
}

type getIndexesResult struct {
	ConnectionID string                       `json:"connectionId"`
	DBName       string                       `json:"dbName,omitempty"`
	TableName    string                       `json:"tableName"`
	Indexes      []connection.IndexDefinition `json:"indexes"`
}

type getForeignKeysResult struct {
	ConnectionID string                            `json:"connectionId"`
	DBName       string                            `json:"dbName,omitempty"`
	TableName    string                            `json:"tableName"`
	ForeignKeys  []connection.ForeignKeyDefinition `json:"foreignKeys"`
}

type getTriggersResult struct {
	ConnectionID string                         `json:"connectionId"`
	DBName       string                         `json:"dbName,omitempty"`
	TableName    string                         `json:"tableName"`
	Triggers     []connection.TriggerDefinition `json:"triggers"`
}

type getTableDDLResult struct {
	ConnectionID string `json:"connectionId"`
	DBName       string `json:"dbName,omitempty"`
	TableName    string `json:"tableName"`
	DDL          string `json:"ddl"`
}

type sqlStatementSummary struct {
	Index    int    `json:"index"`
	Keyword  string `json:"keyword,omitempty"`
	ReadOnly bool   `json:"readOnly"`
}

type sqlResultSet struct {
	StatementIndex int                      `json:"statementIndex,omitempty"`
	Columns        []string                 `json:"columns"`
	Rows           []map[string]interface{} `json:"rows"`
	Messages       []string                 `json:"messages,omitempty"`
	RowCount       int                      `json:"rowCount"`
	Truncated      bool                     `json:"truncated,omitempty"`
}

type executeSQLResult struct {
	RequestID         string                `json:"requestId,omitempty"`
	ConnectionID      string                `json:"connectionId"`
	DBName            string                `json:"dbName,omitempty"`
	StatementCount    int                   `json:"statementCount"`
	ReadOnly          bool                  `json:"readOnly"`
	QueryID           string                `json:"queryId,omitempty"`
	CancellationState string                `json:"cancellationState,omitempty"`
	Message           string                `json:"message,omitempty"`
	OutcomeUnknown    bool                  `json:"outcomeUnknown,omitempty"`
	Truncated         bool                  `json:"truncated,omitempty"`
	Statements        []sqlStatementSummary `json:"statements"`
	Results           []sqlResultSet        `json:"results"`
}
