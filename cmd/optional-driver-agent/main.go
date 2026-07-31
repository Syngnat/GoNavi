package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type agentRequest struct {
	ID        int64                        `json:"id"`
	Method    string                       `json:"method"`
	SessionID string                       `json:"sessionId,omitempty"`
	Config    *connection.ConnectionConfig `json:"config,omitempty"`
	Query     string                       `json:"query,omitempty"`
	TimeoutMs int64                        `json:"timeoutMs,omitempty"`
	DBName    string                       `json:"dbName,omitempty"`
	TableName string                       `json:"tableName,omitempty"`
	Changes   *connection.ChangeSet        `json:"changes,omitempty"`
}

type agentResponse struct {
	ID           int64       `json:"id"`
	Success      bool        `json:"success"`
	Error        string      `json:"error,omitempty"`
	Data         interface{} `json:"data,omitempty"`
	Fields       []string    `json:"fields,omitempty"`
	Messages     []string    `json:"messages,omitempty"`
	ChunkType    string      `json:"chunkType,omitempty"`
	RowsAffected int64       `json:"rowsAffected,omitempty"`
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
	agentMethodGetDatabases        = "getDatabases"
	agentMethodGetTables           = "getTables"
	agentMethodGetCreateStmt       = "getCreateStatement"
	agentMethodGetColumns          = "getColumns"
	agentMethodGetAllColumns       = "getAllColumns"
	agentMethodGetIndexes          = "getIndexes"
	agentMethodGetForeignKey       = "getForeignKeys"
	agentMethodGetTriggers         = "getTriggers"
	agentMethodApplyChanges        = "applyChanges"
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
	agentStreamBatchSize         = 64
	agentMemoryTrimRowsThreshold = 100000
	agentMemoryTrimMinInterval   = 3 * time.Second
)

var (
	agentDriverType         string
	agentDatabaseFactory    func() db.Database
	agentMemoryTrimRunning  atomic.Bool
	agentMemoryTrimLastAt   atomic.Int64
	runAgentMemoryTrimAsync = func(fn func()) {
		go fn()
	}
	agentMemoryTrimFn = func() {
		runtime.GC()
		debug.FreeOSMemory()
	}
)

type agentRuntime struct {
	inst          db.Database
	sessions      map[string]db.StatementExecer
	nextSessionID int64
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

// serveAgentRequests 是 driver-agent 的 JSON-lines 请求主循环。
//
// 用 bufio.Reader 而非 bufio.Scanner：Scanner 有单行长度上限（原为 8 MiB），超限时
// Scan() 直接返回 false 使主循环退出、进程终止，该连接从此永久不可用（主进程侧随后所有
// 请求都拿到 EOF，只能手动重连）。而主进程写入端没有任何上限：一个 1000 行的导入批次或
// 一个大 JSON/CLOB 单元格都能轻易超过 8 MiB。bufio.Reader.ReadString 会按需增长，无单行上限。
//
// 返回非 nil 表示读取过程出现了非 EOF 的真实错误。
func serveAgentRequests(input io.Reader, writer *bufio.Writer, runtimeState *agentRuntime) error {
	reader := bufio.NewReaderSize(input, 16<<10)
	for {
		raw, err := reader.ReadString('\n')
		if err != nil && len(raw) == 0 {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		// err != nil 但 raw 非空：最后一行没有换行符，仍需处理；
		// 下一轮 ReadString 会立即以 len(raw)==0 返回并结束循环。
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		var req agentRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = writeResponse(writer, agentResponse{
				ID:      req.ID,
				Success: false,
				Error:   fmt.Sprintf("解析请求失败：%v", err),
			})
			continue
		}

		if strings.TrimSpace(req.Method) == agentMethodStreamQuery {
			if err := handleStreamRequest(runtimeState, req, writer); err != nil {
				fmt.Fprintf(os.Stderr, "写入流式响应失败：%v\n", err)
				return nil
			}
			continue
		}

		resp := handleRequest(runtimeState, req)
		if err := writeResponse(writer, resp); err != nil {
			fmt.Fprintf(os.Stderr, "写入响应失败：%v\n", err)
			return nil
		}
		if strings.TrimSpace(req.Method) == agentMethodQuery {
			maybeReleaseAgentMemory("query-response", countAgentResponseRows(resp.Data))
		}
	}
}

func handleRequest(runtimeState *agentRuntime, req agentRequest) agentResponse {
	resp := agentResponse{ID: req.ID, Success: true}
	method := strings.TrimSpace(req.Method)

	switch method {
	case agentMethodConnect:
		if req.Config == nil {
			return fail(resp, "连接配置为空")
		}
		runtimeState.close()
		next := agentDatabaseFactory()
		if next == nil {
			return fail(resp, "驱动代理初始化失败")
		}
		if err := next.Connect(*req.Config); err != nil {
			return fail(resp, err.Error())
		}
		runtimeState.inst = next
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
			"protocolSchema": "json-lines-v1",
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
			data, fields, messages, err := queryStatementWithMessagesOptionalTimeout(session, req.Query, req.TimeoutMs)
			if err != nil {
				return fail(resp, err.Error())
			}
			resp.Data = data
			resp.Fields = fields
			resp.Messages = messages
		case agentMethodQueryMulti:
			data, messages, supported, err := queryMultiStatementWithMessagesOptionalTimeout(session, req.Query, req.TimeoutMs)
			if err != nil {
				return fail(resp, err.Error())
			}
			if !supported {
				return fail(resp, "当前事务会话不支持多结果集查询")
			}
			resp.Data = data
			resp.Messages = messages
		case agentMethodExec:
			affected, err := execStatementWithOptionalTimeout(session, req.Query, req.TimeoutMs)
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
		data, fields, messages, err := queryWithMessagesOptionalTimeout(runtimeState.inst, req.Query, req.TimeoutMs)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
		resp.Fields = fields
		resp.Messages = messages
	case agentMethodQueryMulti:
		data, messages, supported, err := queryMultiWithMessagesOptionalTimeout(runtimeState.inst, req.Query, req.TimeoutMs)
		if err != nil {
			return fail(resp, err.Error())
		}
		if !supported {
			return fail(resp, "当前驱动不支持原生多结果集查询")
		}
		resp.Data = data
		resp.Messages = messages
	case agentMethodExec:
		affected, err := execWithOptionalTimeout(runtimeState.inst, req.Query, req.TimeoutMs)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.RowsAffected = affected
	case agentMethodGetDatabases:
		data, err := runtimeState.inst.GetDatabases()
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetTables:
		data, err := runtimeState.inst.GetTables(req.DBName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
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
			return fail(resp, err.Error())
		}
	default:
		return fail(resp, "不支持的方法")
	}

	return resp
}

type agentStreamResponseWriter struct {
	writer    *bufio.Writer
	requestID int64
	columns   []string
	rows      [][]interface{}
	rowCount  int64
}

func newAgentStreamResponseWriter(writer *bufio.Writer, requestID int64) *agentStreamResponseWriter {
	return &agentStreamResponseWriter{
		writer:    writer,
		requestID: requestID,
	}
}

func (w *agentStreamResponseWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	return writeResponse(w.writer, agentResponse{
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
	return writeResponse(w.writer, agentResponse{
		ID:        w.requestID,
		Success:   true,
		ChunkType: agentChunkRows,
		Data:      rows,
	})
}

func (w *agentStreamResponseWriter) finish() error {
	return w.flushRows()
}

func handleStreamRequest(runtimeState *agentRuntime, req agentRequest, writer *bufio.Writer) error {
	resp := agentResponse{ID: req.ID, Success: true}
	if runtimeState.inst == nil {
		return writeResponse(writer, fail(resp, "connection not open"))
	}

	streamWriter := newAgentStreamResponseWriter(writer, req.ID)
	if session, ok, err := runtimeState.session(req.SessionID); err != nil {
		return writeResponse(writer, fail(resp, err.Error()))
	} else if ok {
		if err := streamStatementWithOptionalTimeout(session, req.Query, req.TimeoutMs, streamWriter); err != nil {
			_ = streamWriter.finish()
			return writeResponse(writer, fail(resp, err.Error()))
		}
		if err := streamWriter.finish(); err != nil {
			return err
		}
		if err := writeResponse(writer, agentResponse{ID: req.ID, Success: true, ChunkType: agentChunkDone}); err != nil {
			return err
		}
		maybeReleaseAgentMemory("stream-query-session", streamWriter.rowCount)
		return nil
	}

	if err := streamDatabaseWithOptionalTimeout(runtimeState.inst, req.Query, req.TimeoutMs, streamWriter); err != nil {
		_ = streamWriter.finish()
		return writeResponse(writer, fail(resp, err.Error()))
	}
	if err := streamWriter.finish(); err != nil {
		return err
	}
	if err := writeResponse(writer, agentResponse{ID: req.ID, Success: true, ChunkType: agentChunkDone}); err != nil {
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
	if _, err := writer.Write(payload); err != nil {
		return err
	}
	return writer.Flush()
}

func fail(resp agentResponse, errText string) agentResponse {
	resp.Success = false
	resp.Error = strings.TrimSpace(errText)
	return resp
}

func normalizeAgentResponseData(v interface{}) interface{} {
	if v == nil {
		return nil
	}

	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		return normalizeAgentResponseData(rv.Elem().Interface())
	case reflect.Map:
		if rv.IsNil() {
			return nil
		}
		out := make(map[string]interface{}, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			out[fmt.Sprint(iter.Key().Interface())] = normalizeAgentResponseData(iter.Value().Interface())
		}
		return out
	case reflect.Slice:
		if rv.IsNil() {
			return nil
		}
		// 保持 []byte 原样，避免改变现有二进制列的 JSON 编码行为（base64）。
		if rv.Type().Elem().Kind() == reflect.Uint8 {
			return v
		}
		size := rv.Len()
		items := make([]interface{}, size)
		for i := 0; i < size; i++ {
			items[i] = normalizeAgentResponseData(rv.Index(i).Interface())
		}
		return items
	case reflect.Array:
		size := rv.Len()
		items := make([]interface{}, size)
		for i := 0; i < size; i++ {
			items[i] = normalizeAgentResponseData(rv.Index(i).Interface())
		}
		return items
	default:
		return v
	}
}

type agentQueryRunner interface {
	Query(string) ([]map[string]interface{}, []string, error)
}

type agentQueryContextRunner interface {
	QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
}

type agentQueryMessageRunner interface {
	QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error)
}

type agentQueryMessageContextRunner interface {
	QueryContextWithMessages(context.Context, string) ([]map[string]interface{}, []string, []string, error)
}

type agentMultiResultMessageRunner interface {
	QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error)
}

type agentMultiResultMessageContextRunner interface {
	QueryMultiContextWithMessages(context.Context, string) ([]connection.ResultSetData, []string, error)
}

type agentMultiResultRunner interface {
	QueryMulti(query string) ([]connection.ResultSetData, error)
}

type agentMultiResultContextRunner interface {
	QueryMultiContext(context.Context, string) ([]connection.ResultSetData, error)
}

type agentExecRunner interface {
	Exec(string) (int64, error)
}

type agentExecContextRunner interface {
	ExecContext(context.Context, string) (int64, error)
}

func queryWithMessagesOptionalTimeout(inst agentQueryRunner, query string, timeoutMs int64) ([]map[string]interface{}, []string, []string, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	if effectiveTimeoutMs <= 0 {
		if q, ok := inst.(agentQueryMessageRunner); ok {
			return q.QueryWithMessages(query)
		}
		data, fields, err := inst.Query(query)
		return data, fields, nil, err
	}
	if q, ok := inst.(agentQueryMessageContextRunner); ok {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
		defer cancel()
		return q.QueryContextWithMessages(ctx, query)
	}
	if q, ok := inst.(agentQueryContextRunner); ok {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
		defer cancel()
		data, fields, err := q.QueryContext(ctx, query)
		return data, fields, nil, err
	}
	if q, ok := inst.(agentQueryMessageRunner); ok {
		return q.QueryWithMessages(query)
	}
	data, fields, err := inst.Query(query)
	return data, fields, nil, err
}

func queryWithOptionalTimeout(inst agentQueryRunner, query string, timeoutMs int64) ([]map[string]interface{}, []string, error) {
	data, fields, _, err := queryWithMessagesOptionalTimeout(inst, query, timeoutMs)
	return data, fields, err
}

func queryStatementWithOptionalTimeout(inst db.StatementExecer, query string, timeoutMs int64) ([]map[string]interface{}, []string, error) {
	queryRunner, ok := inst.(agentQueryRunner)
	if !ok {
		return nil, nil, fmt.Errorf("当前事务会话不支持查询语句")
	}
	return queryWithOptionalTimeout(queryRunner, query, timeoutMs)
}

func queryStatementWithMessagesOptionalTimeout(inst db.StatementExecer, query string, timeoutMs int64) ([]map[string]interface{}, []string, []string, error) {
	queryRunner, ok := inst.(agentQueryRunner)
	if !ok {
		return nil, nil, nil, fmt.Errorf("当前事务会话不支持查询语句")
	}
	return queryWithMessagesOptionalTimeout(queryRunner, query, timeoutMs)
}

func queryMultiWithMessagesOptionalTimeout(inst db.Database, query string, timeoutMs int64) ([]connection.ResultSetData, []string, bool, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	if effectiveTimeoutMs > 0 {
		if q, ok := inst.(agentMultiResultMessageContextRunner); ok {
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
			defer cancel()
			data, messages, err := q.QueryMultiContextWithMessages(ctx, query)
			return data, messages, true, err
		}
		if q, ok := inst.(agentMultiResultContextRunner); ok {
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
			defer cancel()
			data, err := q.QueryMultiContext(ctx, query)
			return data, nil, true, err
		}
	}
	if q, ok := inst.(agentMultiResultMessageRunner); ok {
		data, messages, err := q.QueryMultiWithMessages(query)
		return data, messages, true, err
	}
	if q, ok := inst.(agentMultiResultRunner); ok {
		data, err := q.QueryMulti(query)
		return data, nil, true, err
	}
	return nil, nil, false, nil
}

func queryMultiStatementWithMessagesOptionalTimeout(inst db.StatementExecer, query string, timeoutMs int64) ([]connection.ResultSetData, []string, bool, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	if effectiveTimeoutMs > 0 {
		if q, ok := inst.(agentMultiResultMessageContextRunner); ok {
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
			defer cancel()
			data, messages, err := q.QueryMultiContextWithMessages(ctx, query)
			return data, messages, true, err
		}
		if q, ok := inst.(agentMultiResultContextRunner); ok {
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
			defer cancel()
			data, err := q.QueryMultiContext(ctx, query)
			return data, nil, true, err
		}
	}
	if q, ok := inst.(agentMultiResultMessageRunner); ok {
		data, messages, err := q.QueryMultiWithMessages(query)
		return data, messages, true, err
	}
	if q, ok := inst.(agentMultiResultRunner); ok {
		data, err := q.QueryMulti(query)
		return data, nil, true, err
	}
	return nil, nil, false, nil
}

func streamWithOptionalTimeout(inst db.StreamQueryExecer, query string, timeoutMs int64, consumer db.QueryStreamConsumer) error {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	if effectiveTimeoutMs <= 0 {
		return inst.StreamQuery(query, consumer)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
	defer cancel()
	return inst.StreamQueryContext(ctx, query, consumer)
}

func streamBufferedQueryResult(fields []string, data []map[string]interface{}, consumer db.QueryStreamConsumer) error {
	if err := consumer.SetColumns(fields); err != nil {
		return err
	}
	if valueConsumer, ok := consumer.(db.QueryStreamValueConsumer); ok {
		for _, row := range data {
			values := make([]interface{}, len(fields))
			for idx, field := range fields {
				values[idx] = row[field]
			}
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
		}
		return nil
	}
	for _, row := range data {
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func streamStatementWithOptionalTimeout(inst db.StatementExecer, query string, timeoutMs int64, consumer db.QueryStreamConsumer) error {
	if streamer, ok := inst.(db.StreamQueryExecer); ok {
		return streamWithOptionalTimeout(streamer, query, timeoutMs, consumer)
	}
	data, fields, err := queryStatementWithOptionalTimeout(inst, query, timeoutMs)
	if err != nil {
		return err
	}
	return streamBufferedQueryResult(fields, data, consumer)
}

func streamDatabaseWithOptionalTimeout(inst db.Database, query string, timeoutMs int64, consumer db.QueryStreamConsumer) error {
	if streamer, ok := inst.(db.StreamQueryExecer); ok {
		return streamWithOptionalTimeout(streamer, query, timeoutMs, consumer)
	}
	if provider, ok := inst.(db.SessionExecerProvider); ok {
		openCtx := context.Background()
		var cancel context.CancelFunc
		effectiveTimeoutMs := timeoutMs
		if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
			effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
		}
		if effectiveTimeoutMs > 0 {
			openCtx, cancel = context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
			defer cancel()
		}
		session, err := provider.OpenSessionExecer(openCtx)
		if err == nil {
			defer session.Close()
			return streamStatementWithOptionalTimeout(session, query, timeoutMs, consumer)
		}
	}
	data, fields, err := queryWithOptionalTimeout(inst, query, timeoutMs)
	if err != nil {
		return err
	}
	return streamBufferedQueryResult(fields, data, consumer)
}

func execWithOptionalTimeout(inst agentExecRunner, query string, timeoutMs int64) (int64, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	if effectiveTimeoutMs <= 0 {
		return inst.Exec(query)
	}
	if e, ok := inst.(agentExecContextRunner); ok {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
		defer cancel()
		return e.ExecContext(ctx, query)
	}
	return inst.Exec(query)
}

func execStatementWithOptionalTimeout(inst db.StatementExecer, query string, timeoutMs int64) (int64, error) {
	return execWithOptionalTimeout(inst, query, timeoutMs)
}

func countAgentResponseRows(data interface{}) int64 {
	rows, ok := data.([]map[string]interface{})
	if !ok {
		return 0
	}
	return int64(len(rows))
}

func maybeReleaseAgentMemory(reason string, rows int64) {
	if rows < agentMemoryTrimRowsThreshold {
		return
	}
	if !agentMemoryTrimRunning.CompareAndSwap(false, true) {
		return
	}

	runAgentMemoryTrimAsync(func() {
		defer agentMemoryTrimRunning.Store(false)
		if delay := nextAgentMemoryTrimDelay(); delay > 0 {
			time.Sleep(delay)
		}
		agentMemoryTrimFn()
		agentMemoryTrimLastAt.Store(time.Now().UnixNano())
	})
}

func nextAgentMemoryTrimDelay() time.Duration {
	lastUnixNano := agentMemoryTrimLastAt.Load()
	if lastUnixNano <= 0 {
		return 0
	}
	elapsed := time.Since(time.Unix(0, lastUnixNano))
	if elapsed >= agentMemoryTrimMinInterval {
		return 0
	}
	return agentMemoryTrimMinInterval - elapsed
}
