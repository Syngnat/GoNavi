package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	sshbridge "GoNavi-Wails/internal/ssh"
)

type agentRequest struct {
	ID         int64                          `json:"id"`
	Method     string                         `json:"method"`
	SessionID  string                         `json:"sessionId,omitempty"`
	Config     *connection.ConnectionConfig   `json:"config,omitempty"`
	SSHRuntime *connection.SSHRuntimeSnapshot `json:"sshRuntime,omitempty"`
	// StreamSSHProgress is an explicit opt-in because older app clients expect
	// exactly one response frame for a connect request.
	StreamSSHProgress bool   `json:"streamSSHProgress,omitempty"`
	Query             string `json:"query,omitempty"`
	// Args 是 json-lines-v2 协议新增的位置绑定参数；旧版主进程不会发送该字段。
	Args                 []any                           `json:"args,omitempty"`
	TimeoutMs            int64                           `json:"timeoutMs,omitempty"`
	RowBudget            *db.RowBudgetOptions            `json:"rowBudget,omitempty"`
	DBName               string                          `json:"dbName,omitempty"`
	TableName            string                          `json:"tableName,omitempty"`
	Changes              *connection.ChangeSet           `json:"changes,omitempty"`
	AttachSpec           *db.ExternalAttachSpec          `json:"attachSpec,omitempty"`
	Alias                string                          `json:"alias,omitempty"`
	ElasticsearchRequest *db.ElasticsearchConsoleRequest `json:"elasticsearchRequest,omitempty"`
	// TargetID 仅用于取消通知：指向要中止的在途请求 ID。
	TargetID int64 `json:"targetId,omitempty"`
}

type agentResponse struct {
	ID                        int64                         `json:"id"`
	Success                   bool                          `json:"success"`
	Error                     string                        `json:"error,omitempty"`
	OutcomeUnknown            bool                          `json:"outcomeUnknown,omitempty"` // ExternalAttachNotAttached 标记 DETACH 目标别名不存在（幂等语义）。
	ExternalAttachNotAttached bool                          `json:"externalAttachNotAttached,omitempty"`
	SSHHostKeyTrust           *sshbridge.HostKeyTrustStatus `json:"sshHostKeyTrust,omitempty"`
	SSHProgress               *connection.SSHProgressEvent  `json:"sshProgress,omitempty"`
	Data                      interface{}                   `json:"data,omitempty"`
	Fields                    []string                      `json:"fields,omitempty"`
	Messages                  []string                      `json:"messages,omitempty"`
	ChunkType                 string                        `json:"chunkType,omitempty"`
	RowsAffected              int64                         `json:"rowsAffected,omitempty"`
	Truncated                 bool                          `json:"truncated,omitempty"`
	BudgetExhausted           bool                          `json:"budgetExhausted,omitempty"`
	// PartialData 表示失败响应仍携带部分结果（如 Pulsar 主题发现失败时的已知主题）；
	// 旧版主进程忽略该字段，只看到错误。
	PartialData bool `json:"partialData,omitempty"`
}

const (
	agentMethodConnect             = "connect"
	agentMethodClose               = "close"
	agentMethodMetadata            = "metadata"
	agentMethodPing                = "ping"
	agentMethodOpenSession         = "openSession"
	agentMethodCloseSession        = "closeSession"
	agentMethodOpenTransaction     = "openTransaction"
	agentMethodCommitTransaction   = "commitTransaction"
	agentMethodRollbackTransaction = "rollbackTransaction"
	agentMethodQuery               = "query"
	agentMethodQueryMulti          = "queryMulti"
	agentMethodStreamQuery         = "streamQuery"
	agentMethodExec                = "exec"
	// agentMethodCancelQuery 中止指定的在途请求：它是唯一不回帧的方法，主进程通过
	// 被取消请求自己的响应观察结果，以便查询执行期间也能送达（详见 request_dispatch.go）。
	agentMethodCancelQuery             = "cancelQuery"
	agentMethodElasticsearchConsole    = "executeElasticsearchConsoleRequest"
	agentMethodGetDatabases            = "getDatabases"
	agentMethodGetTables               = "getTables"
	agentMethodTableExists             = "tableExists"
	agentMethodGetCreateStmt           = "getCreateStatement"
	agentMethodGetColumns              = "getColumns"
	agentMethodGetAllColumns           = "getAllColumns"
	agentMethodGetIndexes              = "getIndexes"
	agentMethodGetForeignKey           = "getForeignKeys"
	agentMethodGetTriggers             = "getTriggers"
	agentMethodApplyChanges            = "applyChanges"
	agentMethodAttachExternalDatabase  = "attachExternalDatabase"
	agentMethodDetachExternalDatabase  = "detachExternalDatabase"
	agentMethodListExternalAttachments = "listExternalAttachments"
)

const legacyClickHouseDefaultTimeout = 2 * time.Hour

const (
	agentChunkColumns = "columns"
	agentChunkRows    = "rows"
	agentChunkDone    = "done"
	// agentStreamBatchSize 控制 driver-agent 向主进程发送 row chunk 的批次大小。
	// 调小到 64：单批 JSON 编码 + 主进程解码的瞬时内存峰值降为原来的 1/4，
	// 代价是 IPC 次数变为 4 倍，但每批仅一次 stdin/stdout 行读写，整体影响可忽略。
	// 重要：减小批次不能根除内存峰值，仍需配合 SetGCPercent + 周期 GC（见 main）。
	agentStreamBatchSize = 64
)

var (
	agentDriverType      string
	agentDatabaseFactory func() db.Database
)

type agentRuntime struct {
	inst          db.Database
	sessions      map[string]db.StatementExecer
	nextSessionID int64
	// canceller 登记当前在途业务请求的取消入口，供取消通知使用。
	canceller agentRequestCanceller
}

func main() {
	if agentDatabaseFactory == nil || strings.TrimSpace(agentDriverType) == "" {
		fmt.Fprintf(os.Stderr, "未配置驱动代理 provider，请使用 gonavi_<driver>_driver 标签构建\n")
		os.Exit(2)
	}

	// driver-agent 是独立进程，主进程无法控制其 GC 行为。
	// 大结果集（88W+ 行）通过 JSON-lines 跨进程传输时，每行有 5-8 倍内存副本；
	// Go 默认 GOGC=100 + Windows MADV_FREE 不归还 RSS，会导致 driver-agent 进程
	// 内存峰值达到数据总量的 10+ 倍（用户实测 88W 普通业务表撑到 8G+）。
	//
	// GC 策略组合：
	//   - SetGCPercent(50)：堆增长 50% 即触发 GC，比默认 100 更早收敛
	//   - InitMemorySoftLimit：起始 2GB，运行时由 MaybeGrowMemoryLimit 自适应抬升到最多 8GB
	//     （起步保守 + 按需扩张，避免静态 2GB 限制在大表场景触发 GC 硬模式降速 15-25%）
	//
	// 代价：CPU 开销增加约 5-10%。导出场景是 I/O 密集型，可忽略。
	debug.SetGCPercent(50)
	db.InitMemorySoftLimit(db.MemorySoftLimitInitialBytes)

	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	runtimeState := &agentRuntime{
		sessions: make(map[string]db.StatementExecer),
	}
	readErr := serveAgentRequests(os.Stdin, writer, runtimeState)

	runtimeState.close()

	if readErr != nil {
		fmt.Fprintf(os.Stderr, "读取请求失败：%v\n", readErr)
	}
}

func handleRequest(runtimeState *agentRuntime, req agentRequest) agentResponse {
	return handleRequestWithContext(context.Background(), runtimeState, req, nil)
}

func handleConnectRequest(requestCtx context.Context, runtimeState *agentRuntime, req agentRequest, writer *agentResponseWriter) error {
	progressWriter := newSSHProgressResponseWriter(writer, req.ID)
	resp := handleRequestWithContext(requestCtx, runtimeState, req, progressWriter.report)
	if err := progressWriter.close(); err != nil {
		return err
	}
	return writer.write(resp)
}

// handleRequestWithContext 执行一条业务请求。
//
// requestCtx 是本次请求的生命周期上下文：取消通知会取消它，驱动层据此中止正在执行的
// 语句（见 request_dispatch.go）。注意它只约束本次请求，不影响请求结束后仍需存活的
// 事务会话。
func handleRequestWithContext(requestCtx context.Context, runtimeState *agentRuntime, req agentRequest, progressReporter connection.SSHProgressReporter) agentResponse {
	resp := agentResponse{ID: req.ID, Success: true}
	method := strings.TrimSpace(req.Method)

	switch method {
	case agentMethodConnect:
		if req.Config == nil {
			return fail(resp, "连接配置为空")
		}
		config := *req.Config
		if config.UseSSH {
			config.SSH = config.SSH.WithRuntimeSnapshot(req.SSHRuntime)
			if progressReporter != nil {
				config.SSH = config.SSH.WithProgressReporter(progressReporter)
			}
		}
		runtimeState.close()
		next := agentDatabaseFactory()
		if next == nil {
			return fail(resp, "驱动代理初始化失败")
		}
		if err := next.Connect(config); err != nil {
			return failWithSSHHostKeyTrust(resp, err)
		}
		runtimeState.inst = next
		resp.Data = newAgentConnectionInfo(next)
		return resp
	case agentMethodClose:
		if runtimeState.inst != nil {
			if err := runtimeState.close(); err != nil {
				return fail(resp, err.Error())
			}
		}
		return resp
	case agentMethodMetadata:
		resp.Data = map[string]string{
			"driverType":     strings.TrimSpace(agentDriverType),
			"agentRevision":  db.OptionalDriverAgentRevision(agentDriverType),
			"protocolSchema": agentProtocolSchemaV2,
		}
		return resp
	case agentMethodOpenSession:
		if runtimeState.inst == nil {
			return fail(resp, "connection not open")
		}
		provider, ok := runtimeState.inst.(db.SessionExecerProvider)
		if !ok {
			return fail(resp, fmt.Sprintf("当前数据源（%s）不支持 SQL 编辑器托管事务", strings.TrimSpace(agentDriverType)))
		}
		openCtx := context.Background()
		var cancel context.CancelFunc
		if req.TimeoutMs > 0 {
			openCtx, cancel = context.WithTimeout(context.Background(), time.Duration(req.TimeoutMs)*time.Millisecond)
			defer cancel()
		}
		session, err := provider.OpenSessionExecer(openCtx)
		if err != nil {
			return fail(resp, err.Error())
		}
		sessionID := runtimeState.nextID()
		runtimeState.sessions[sessionID] = session
		resp.Data = sessionID
		return resp
	case agentMethodOpenTransaction:
		if runtimeState.inst == nil {
			return fail(resp, "connection not open")
		}
		provider, ok := runtimeState.inst.(db.TransactionExecerProvider)
		if !ok {
			return fail(resp, fmt.Sprintf("当前数据源（%s）不支持 SQL 编辑器托管事务", strings.TrimSpace(agentDriverType)))
		}
		// The transaction must outlive this request and be finished by a later RPC.
		transaction, err := provider.OpenTransactionExecer(context.Background())
		if err != nil {
			return fail(resp, err.Error())
		}
		sessionID := runtimeState.nextID()
		runtimeState.sessions[sessionID] = transaction
		resp.Data = sessionID
		return resp
	case agentMethodCloseSession:
		if err := runtimeState.closeSession(req.SessionID); err != nil {
			return fail(resp, err.Error())
		}
		return resp
	}

	if runtimeState.inst == nil {
		return fail(resp, "connection not open")
	}

	if session, ok, err := runtimeState.session(req.SessionID); err != nil {
		return fail(resp, err.Error())
	} else if ok {
		switch method {
		case agentMethodQuery:
			if len(req.Args) > 0 {
				data, fields, messages, err := queryStatementWithArgsOptionalTimeout(requestCtx, session, req.Query, req.Args, req.TimeoutMs)
				if err != nil {
					return fail(resp, err.Error())
				}
				resp.Data = data
				resp.Fields = fields
				resp.Messages = messages
				break
			}
			data, fields, messages, budget, err := queryStatementWithMessagesRequest(requestCtx, session, req.Query, req.TimeoutMs, req.RowBudget)
			if err != nil {
				return fail(resp, err.Error())
			}
			resp.Data = data
			resp.Fields = fields
			resp.Messages = messages
			applyAgentBudgetResponse(&resp, budget)
		case agentMethodQueryMulti:
			data, messages, supported, budget, err := queryMultiStatementWithMessagesRequest(requestCtx, session, req.Query, req.TimeoutMs, req.RowBudget)
			if err != nil {
				return fail(resp, err.Error())
			}
			if !supported {
				return fail(resp, "当前事务会话不支持多结果集查询")
			}
			resp.Data = data
			resp.Messages = messages
			applyAgentBudgetResponse(&resp, budget)
		case agentMethodExec:
			if len(req.Args) > 0 {
				affected, err := execStatementWithArgsOptionalTimeout(requestCtx, session, req.Query, req.Args, req.TimeoutMs)
				if err != nil {
					return fail(resp, err.Error())
				}
				resp.RowsAffected = affected
				break
			}
			affected, err := execStatementWithOptionalTimeout(requestCtx, session, req.Query, req.TimeoutMs)
			if err != nil {
				return fail(resp, err.Error())
			}
			resp.RowsAffected = affected
		case agentMethodCommitTransaction, agentMethodRollbackTransaction:
			transaction, ok := session.(db.TransactionExecer)
			if !ok {
				return fail(resp, "当前会话不是托管事务")
			}
			var err error
			if method == agentMethodCommitTransaction {
				err = transaction.Commit()
			} else {
				err = transaction.Rollback()
			}
			if err != nil {
				return fail(resp, err.Error())
			}
		default:
			return fail(resp, "当前事务会话不支持该方法")
		}
		return resp
	}

	switch method {
	case agentMethodPing:
		if err := runtimeState.inst.Ping(); err != nil {
			return fail(resp, err.Error())
		}
	case agentMethodQuery:
		if len(req.Args) > 0 {
			data, fields, messages, err := queryWithArgsOptionalTimeout(requestCtx, runtimeState.inst, req.Query, req.Args, req.TimeoutMs)
			if err != nil {
				return fail(resp, err.Error())
			}
			resp.Data = data
			resp.Fields = fields
			resp.Messages = messages
			break
		}
		data, fields, messages, budget, err := queryWithMessagesRequest(requestCtx, runtimeState.inst, req.Query, req.TimeoutMs, req.RowBudget)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
		resp.Fields = fields
		resp.Messages = messages
		applyAgentBudgetResponse(&resp, budget)
	case agentMethodQueryMulti:
		data, messages, supported, budget, err := queryMultiWithMessagesRequest(requestCtx, runtimeState.inst, req.Query, req.TimeoutMs, req.RowBudget)
		if err != nil {
			return fail(resp, err.Error())
		}
		if !supported {
			return fail(resp, "当前驱动不支持原生多结果集查询")
		}
		resp.Data = data
		resp.Messages = messages
		applyAgentBudgetResponse(&resp, budget)
	case agentMethodExec:
		if len(req.Args) > 0 {
			affected, err := execWithArgsOptionalTimeout(requestCtx, runtimeState.inst, req.Query, req.Args, req.TimeoutMs)
			if err != nil {
				return fail(resp, err.Error())
			}
			resp.RowsAffected = affected
			break
		}
		affected, err := execWithOptionalTimeout(requestCtx, runtimeState.inst, req.Query, req.TimeoutMs)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.RowsAffected = affected
	case agentMethodElasticsearchConsole:
		if req.ElasticsearchRequest == nil {
			return fail(resp, "Elasticsearch Console 请求为空")
		}
		executor, ok := runtimeState.inst.(db.ElasticsearchConsoleExecutor)
		if !ok {
			return fail(resp, "当前驱动不支持 Elasticsearch Console")
		}
		executeCtx := context.Background()
		var cancel context.CancelFunc
		if req.TimeoutMs > 0 {
			executeCtx, cancel = context.WithTimeout(executeCtx, time.Duration(req.TimeoutMs)*time.Millisecond)
			defer cancel()
		}
		data, err := executor.ExecuteElasticsearchConsoleRequest(executeCtx, *req.ElasticsearchRequest)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetDatabases:
		data, err := runtimeState.inst.GetDatabases()
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetTables:
		data, err := runtimeState.inst.GetTables(req.DBName)
		if err != nil {
			failed := fail(resp, err.Error())
			if len(data) > 0 {
				failed.Data = data
				failed.PartialData = true
			}
			return failed
		}
		resp.Data = data
	case agentMethodTableExists:
		if checker, ok := runtimeState.inst.(db.TableExistsChecker); ok {
			exists, err := checker.TableExists(req.DBName, req.TableName)
			if err != nil {
				return fail(resp, err.Error())
			}
			resp.Data = exists
			break
		}
		tables, err := runtimeState.inst.GetTables(req.DBName)
		if err != nil {
			return fail(resp, err.Error())
		}
		target := strings.TrimSpace(req.TableName)
		exists := false
		for _, table := range tables {
			if strings.TrimSpace(table) == target {
				exists = true
				break
			}
		}
		resp.Data = exists
	case agentMethodGetCreateStmt:
		data, err := runtimeState.inst.GetCreateStatement(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetColumns:
		data, err := runtimeState.inst.GetColumns(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetAllColumns:
		data, err := runtimeState.inst.GetAllColumns(req.DBName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetIndexes:
		data, err := runtimeState.inst.GetIndexes(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetForeignKey:
		data, err := runtimeState.inst.GetForeignKeys(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetTriggers:
		data, err := runtimeState.inst.GetTriggers(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodAttachExternalDatabase:
		if runtimeState.inst == nil {
			return fail(resp, "connection not open")
		}
		if req.AttachSpec == nil {
			return fail(resp, "attach spec is empty")
		}
		attacher, ok := runtimeState.inst.(db.ExternalDatabaseAttacher)
		if !ok {
			return fail(resp, fmt.Sprintf("当前数据源（%s）不支持附加外部数据源", strings.TrimSpace(agentDriverType)))
		}
		attachCtx := context.Background()
		var attachCancel context.CancelFunc
		if req.TimeoutMs > 0 {
			attachCtx, attachCancel = context.WithTimeout(attachCtx, time.Duration(req.TimeoutMs)*time.Millisecond)
			defer attachCancel()
		}
		if err := attacher.AttachExternalDatabase(attachCtx, *req.AttachSpec); err != nil {
			return failWithExternalAttachNotAttached(resp, err)
		}
		return resp
	case agentMethodDetachExternalDatabase:
		if runtimeState.inst == nil {
			return fail(resp, "connection not open")
		}
		attacher, ok := runtimeState.inst.(db.ExternalDatabaseAttacher)
		if !ok {
			return fail(resp, fmt.Sprintf("当前数据源（%s）不支持附加外部数据源", strings.TrimSpace(agentDriverType)))
		}
		detachCtx := context.Background()
		var detachCancel context.CancelFunc
		if req.TimeoutMs > 0 {
			detachCtx, detachCancel = context.WithTimeout(detachCtx, time.Duration(req.TimeoutMs)*time.Millisecond)
			defer detachCancel()
		}
		if err := attacher.DetachExternalDatabase(detachCtx, req.Alias); err != nil {
			return failWithExternalAttachNotAttached(resp, err)
		}
		return resp

	case agentMethodListExternalAttachments:
		if runtimeState.inst == nil {
			return fail(resp, "connection not open")
		}
		lister, ok := runtimeState.inst.(db.ExternalAttachmentLister)
		if !ok {
			return fail(resp, fmt.Sprintf("当前数据源（%s）不支持附加外部数据源", strings.TrimSpace(agentDriverType)))
		}
		listCtx := context.Background()
		var listCancel context.CancelFunc
		if req.TimeoutMs > 0 {
			listCtx, listCancel = context.WithTimeout(listCtx, time.Duration(req.TimeoutMs)*time.Millisecond)
			defer listCancel()
		}
		attachments, listErr := lister.ListExternalAttachments(listCtx)
		if listErr != nil {
			return fail(resp, listErr.Error())
		}
		resp.Data = attachments
		return resp
	case agentMethodPreviewChanges:
		return handlePreviewChanges(runtimeState.inst, req, resp)
	case agentMethodApplyChanges:
		if req.Changes == nil {
			return fail(resp, "变更集为空")
		}
		applier, ok := runtimeState.inst.(interface {
			ApplyChanges(tableName string, changes connection.ChangeSet) error
		})
		if !ok {
			return fail(resp, "当前驱动不支持 ApplyChanges")
		}
		if err := applier.ApplyChanges(req.TableName, *req.Changes); err != nil {
			resp = fail(resp, err.Error())
			resp.OutcomeUnknown = db.IsWriteOutcomeUnknown(err)
			return resp
		}
	default:
		return fail(resp, "不支持的方法")
	}

	return resp
}

type sshProgressResponseWriter struct {
	writer    *agentResponseWriter
	requestID int64
	mu        sync.Mutex
	err       error
	closed    bool
}

func newSSHProgressResponseWriter(writer *agentResponseWriter, requestID int64) *sshProgressResponseWriter {
	return &sshProgressResponseWriter{writer: writer, requestID: requestID}
}

func (w *sshProgressResponseWriter) report(event connection.SSHProgressEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.err != nil {
		return
	}
	eventCopy := event
	w.err = w.writer.write(agentResponse{
		ID:          w.requestID,
		Success:     true,
		SSHProgress: &eventCopy,
	})
}

func (w *sshProgressResponseWriter) close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	return w.err
}

type agentStreamResponseWriter struct {
	writer    *agentResponseWriter
	requestID int64
	columns   []string
	rows      [][]interface{}
	rowCount  int64
}

func newAgentStreamResponseWriter(writer *agentResponseWriter, requestID int64) *agentStreamResponseWriter {
	return &agentStreamResponseWriter{
		writer:    writer,
		requestID: requestID,
	}
}

func (w *agentStreamResponseWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	return w.writer.write(agentResponse{
		ID:        w.requestID,
		Success:   true,
		ChunkType: agentChunkColumns,
		Fields:    w.columns,
	})
}

func (w *agentStreamResponseWriter) ConsumeRow(row map[string]interface{}) error {
	if len(w.columns) == 0 {
		return fmt.Errorf("流式查询缺少列定义")
	}
	values := make([]interface{}, len(w.columns))
	for idx, column := range w.columns {
		values[idx] = row[column]
	}
	return w.ConsumeRowValues(values)
}

func (w *agentStreamResponseWriter) ConsumeRowValues(values []interface{}) error {
	row := append([]interface{}(nil), values...)
	w.rows = append(w.rows, row)
	w.rowCount++
	if len(w.rows) < agentStreamBatchSize {
		return nil
	}
	return w.flushRows()
}

func (w *agentStreamResponseWriter) flushRows() error {
	if len(w.rows) == 0 {
		return nil
	}
	rows := w.rows
	w.rows = nil
	for len(rows) > 0 {
		batch := rows
		for {
			err := w.writer.write(agentResponse{
				ID:        w.requestID,
				Success:   true,
				ChunkType: agentChunkRows,
				Data:      batch,
			})
			if err == nil {
				break
			}
			if !errors.Is(err, db.ErrOptionalDriverAgentJSONLineTooLarge) || len(batch) == 1 {
				return err
			}
			batch = batch[:len(batch)/2]
		}
		rows = rows[len(batch):]
	}
	return nil
}

func (w *agentStreamResponseWriter) finish() error {
	return w.flushRows()
}

func handleStreamRequest(requestCtx context.Context, runtimeState *agentRuntime, req agentRequest, writer *agentResponseWriter) error {
	resp := agentResponse{ID: req.ID, Success: true}
	if runtimeState.inst == nil {
		return writer.write(fail(resp, "connection not open"))
	}

	streamWriter := newAgentStreamResponseWriter(writer, req.ID)
	if session, ok, err := runtimeState.session(req.SessionID); err != nil {
		return writer.write(fail(resp, err.Error()))
	} else if ok {
		if err := streamStatementWithOptionalTimeout(requestCtx, session, req.Query, req.TimeoutMs, streamWriter); err != nil {
			_ = streamWriter.finish()
			return writer.write(fail(resp, err.Error()))
		}
		if err := streamWriter.finish(); err != nil {
			return err
		}
		if err := writer.write(agentResponse{ID: req.ID, Success: true, ChunkType: agentChunkDone}); err != nil {
			return err
		}
		maybeReleaseAgentMemory("stream-query-session", streamWriter.rowCount)
		return nil
	}

	if err := streamDatabaseWithOptionalTimeout(requestCtx, runtimeState.inst, req.Query, req.TimeoutMs, streamWriter); err != nil {
		_ = streamWriter.finish()
		return writer.write(fail(resp, err.Error()))
	}
	if err := streamWriter.finish(); err != nil {
		return err
	}
	if err := writer.write(agentResponse{ID: req.ID, Success: true, ChunkType: agentChunkDone}); err != nil {
		return err
	}
	maybeReleaseAgentMemory("stream-query-db", streamWriter.rowCount)
	return nil
}

func (r *agentRuntime) nextID() string {
	r.ensureSessionMap()
	r.nextSessionID++
	return "session-" + strconv.FormatInt(r.nextSessionID, 10)
}

func (r *agentRuntime) session(sessionID string) (db.StatementExecer, bool, error) {
	r.ensureSessionMap()
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, false, nil
	}
	session, ok := r.sessions[sessionID]
	if !ok || session == nil {
		return nil, false, fmt.Errorf("事务会话不存在或已结束")
	}
	return session, true, nil
}

func (r *agentRuntime) closeSession(sessionID string) error {
	r.ensureSessionMap()
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return fmt.Errorf("事务会话 ID 不能为空")
	}
	session, ok := r.sessions[sessionID]
	if ok {
		delete(r.sessions, sessionID)
	}
	if !ok || session == nil {
		return fmt.Errorf("事务会话不存在或已结束")
	}
	return session.Close()
}

func (r *agentRuntime) close() error {
	var closeErr error
	r.ensureSessionMap()
	for sessionID, session := range r.sessions {
		delete(r.sessions, sessionID)
		if session != nil {
			if err := session.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		}
	}
	if r.inst != nil {
		if err := r.inst.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
		r.inst = nil
	}
	return closeErr
}

func (r *agentRuntime) ensureSessionMap() {
	if r.sessions == nil {
		r.sessions = make(map[string]db.StatementExecer)
	}
}

func writeResponse(writer *bufio.Writer, resp agentResponse) error {
	// 对响应数据做统一 JSON 安全归一化：
	// 将 map[any]any（如 duckdb.Map）递归转换为 map[string]any，避免序列化失败导致代理进程退出。
	safeResp := resp
	safeResp.Data = normalizeAgentResponseData(resp.Data)
	payload, err := json.Marshal(safeResp)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if len(payload) > db.OptionalDriverAgentMaxJSONLineBytes {
		return db.ErrOptionalDriverAgentJSONLineTooLarge
	}
	if _, err := writer.Write(payload); err != nil {
		return err
	}
	return writer.Flush()
}

// failWithExternalAttachNotAttached 在错误为“别名未附加”哨兵时打上协议标记，
// 主进程据此把 DETACH 未附加映射为幂等提示而不是失败。
func failWithExternalAttachNotAttached(resp agentResponse, err error) agentResponse {
	failed := fail(resp, err.Error())
	if errors.Is(err, db.ErrExternalAttachNotAttached) {
		failed.ExternalAttachNotAttached = true
	}
	return failed
}
