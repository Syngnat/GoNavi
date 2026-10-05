package db

import (
	"encoding/json"
	"errors"
	"time"

	"GoNavi-Wails/internal/connection"
	sshbridge "GoNavi-Wails/internal/ssh"
)

const (
	optionalAgentMethodConnect                 = "connect"
	optionalAgentMethodClose                   = "close"
	optionalAgentMethodMetadata                = "metadata"
	optionalAgentMethodPing                    = "ping"
	optionalAgentMethodOpenSession             = "openSession"
	optionalAgentMethodCloseSession            = "closeSession"
	optionalAgentMethodOpenTransaction         = "openTransaction"
	optionalAgentMethodCommitTransaction       = "commitTransaction"
	optionalAgentMethodRollbackTransaction     = "rollbackTransaction"
	optionalAgentMethodQuery                   = "query"
	optionalAgentMethodQueryMulti              = "queryMulti"
	optionalAgentMethodStreamQuery             = "streamQuery"
	optionalAgentMethodExec                    = "exec"
	optionalAgentMethodElasticsearchConsole    = "executeElasticsearchConsoleRequest"
	optionalAgentMethodGetDatabases            = "getDatabases"
	optionalAgentMethodGetTables               = "getTables"
	optionalAgentMethodTableExists             = "tableExists"
	optionalAgentMethodGetCreateStmt           = "getCreateStatement"
	optionalAgentMethodGetColumns              = "getColumns"
	optionalAgentMethodGetAllColumns           = "getAllColumns"
	optionalAgentMethodGetIndexes              = "getIndexes"
	optionalAgentMethodGetForeignKeys          = "getForeignKeys"
	optionalAgentMethodGetTriggers             = "getTriggers"
	optionalAgentMethodApplyChanges            = "applyChanges"
	optionalAgentMethodAttachExternalDatabase  = "attachExternalDatabase"
	optionalAgentMethodDetachExternalDatabase  = "detachExternalDatabase"
	optionalAgentMethodListExternalAttachments = "listExternalAttachments"
	optionalAgentDefaultScannerMaxBytes        = 8 << 20
	// Freshly downloaded agents may start slowly while OS security scanning completes.
	optionalAgentMetadataProbeTimeout = 30 * time.Second
	// A Windows security scanner can hold the first process start long enough to
	// hit the primary budget, then allow the same file to start immediately.
	// Keep this as a retry budget only; the primary metadata contract remains 30s.
	optionalAgentMetadataProbeRetryTimeout = 5 * time.Second
	optionalAgentMetadataProbeRetryDelay   = 100 * time.Millisecond
	optionalAgentControlCallTimeout        = 30 * time.Second
	optionalAgentShutdownCallTimeout       = 2 * time.Second
)

var errOptionalAgentTransportStopped = errors.New("驱动代理传输已关闭")

type optionalAgentRequest struct {
	ID         int64                          `json:"id"`
	Method     string                         `json:"method"`
	SessionID  string                         `json:"sessionId,omitempty"`
	Config     *connection.ConnectionConfig   `json:"config,omitempty"`
	SSHRuntime *connection.SSHRuntimeSnapshot `json:"sshRuntime,omitempty"`
	// StreamSSHProgress is an explicit protocol capability. Older agents ignore
	// it, while newer agents preserve the historical one-response contract until
	// a supporting client opts in.
	StreamSSHProgress bool   `json:"streamSSHProgress,omitempty"`
	Query             string `json:"query,omitempty"`
	// Args 是按占位符顺序排列的位置绑定参数，仅在 json-lines-v2 及以上协议
	// 中发送（omitempty 保证旧协议报文不携带该字段）。
	Args                 []any                        `json:"args,omitempty"`
	TimeoutMs            int64                        `json:"timeoutMs,omitempty"`
	RowBudget            *RowBudgetOptions            `json:"rowBudget,omitempty"`
	DBName               string                       `json:"dbName,omitempty"`
	TableName            string                       `json:"tableName,omitempty"`
	Changes              *connection.ChangeSet        `json:"changes,omitempty"`
	AttachSpec           *ExternalAttachSpec          `json:"attachSpec,omitempty"`
	Alias                string                       `json:"alias,omitempty"`
	ElasticsearchRequest *ElasticsearchConsoleRequest `json:"elasticsearchRequest,omitempty"`
	// TargetID 仅用于取消通知：指向要中止的在途请求 ID，旧版 agent 不会收到该字段。
	TargetID int64 `json:"targetId,omitempty"`
	// sshProgressReporter remains in the main process and is never serialized
	// into the driver-agent request.
	sshProgressReporter connection.SSHProgressReporter `json:"-"`
	rowBudget           *RowBudget                     `json:"-"`
}

type optionalAgentResponse struct {
	ID                        int64                         `json:"id"`
	Success                   bool                          `json:"success"`
	Error                     string                        `json:"error,omitempty"`
	OutcomeUnknown            bool                          `json:"outcomeUnknown,omitempty"`
	ExternalAttachNotAttached bool                          `json:"externalAttachNotAttached,omitempty"`
	SSHHostKeyTrust           *sshbridge.HostKeyTrustStatus `json:"sshHostKeyTrust,omitempty"`
	SSHProgress               *connection.SSHProgressEvent  `json:"sshProgress,omitempty"`
	Data                      json.RawMessage               `json:"data,omitempty"`
	Fields                    []string                      `json:"fields,omitempty"`
	Messages                  []string                      `json:"messages,omitempty"`
	ChunkType                 string                        `json:"chunkType,omitempty"`
	RowsAffected              int64                         `json:"rowsAffected,omitempty"`
	Truncated                 bool                          `json:"truncated,omitempty"`
	BudgetExhausted           bool                          `json:"budgetExhausted,omitempty"`
	// PartialData 表示失败响应仍携带部分结果；客户端解析数据后照常返回错误。
	PartialData bool `json:"partialData,omitempty"`
}

type OptionalDriverAgentMetadata struct {
	DriverType     string `json:"driverType,omitempty"`
	AgentRevision  string `json:"agentRevision,omitempty"`
	ProtocolSchema string `json:"protocolSchema,omitempty"`
}
