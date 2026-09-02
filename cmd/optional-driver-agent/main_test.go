package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	sshbridge "GoNavi-Wails/internal/ssh"
)

type duckMapLike map[any]any

func TestWriteResponse_NormalizesMapAnyAny(t *testing.T) {
	resp := agentResponse{
		ID:      1,
		Success: true,
		Data: []map[string]interface{}{
			{
				"id":   int64(7),
				"meta": duckMapLike{"k": "v", 2: "two"},
			},
		},
	}

	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	if err := writeResponse(writer, resp); err != nil {
		t.Fatalf("writeResponse 返回错误: %v", err)
	}

	var decoded struct {
		Data []map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &decoded); err != nil {
		t.Fatalf("解码响应失败: %v", err)
	}

	if len(decoded.Data) != 1 {
		t.Fatalf("期望 1 行数据，实际 %d", len(decoded.Data))
	}
	meta, ok := decoded.Data[0]["meta"].(map[string]interface{})
	if !ok {
		t.Fatalf("meta 字段类型异常: %T", decoded.Data[0]["meta"])
	}
	if meta["k"] != "v" {
		t.Fatalf("字符串 key 转换异常: %v", meta["k"])
	}
	if meta["2"] != "two" {
		t.Fatalf("数字 key 未字符串化: %v", meta["2"])
	}
}

func TestNormalizeAgentResponseData_KeepByteSlice(t *testing.T) {
	raw := []byte{0x61, 0x62, 0x63}
	normalized := normalizeAgentResponseData(raw)
	out, ok := normalized.([]byte)
	if !ok {
		t.Fatalf("期望 []byte，实际 %T", normalized)
	}
	if !bytes.Equal(out, raw) {
		t.Fatalf("[]byte 内容被意外改写: %v", out)
	}
}

func TestHandleRequestMetadataReportsAgentRevision(t *testing.T) {
	previousDriverType := agentDriverType
	previousFactory := agentDatabaseFactory
	t.Cleanup(func() {
		agentDriverType = previousDriverType
		agentDatabaseFactory = previousFactory
	})
	agentDriverType = "clickhouse"
	agentDatabaseFactory = func() db.Database { return nil }

	runtimeState := &agentRuntime{sessions: make(map[string]db.StatementExecer)}
	resp := handleRequest(runtimeState, agentRequest{ID: 7, Method: agentMethodMetadata})
	if !resp.Success {
		t.Fatalf("metadata request failed: %s", resp.Error)
	}
	data, ok := resp.Data.(map[string]string)
	if !ok {
		t.Fatalf("metadata response data type = %T", resp.Data)
	}
	if data["driverType"] != "clickhouse" {
		t.Fatalf("unexpected driver type: %q", data["driverType"])
	}
	if data["agentRevision"] != db.OptionalDriverAgentRevision("clickhouse") {
		t.Fatalf("unexpected agent revision: %q", data["agentRevision"])
	}
}

type fakeAgentTimeoutDB struct {
	queryCalled        bool
	queryContextCalled bool
	execCalled         bool
	execContextCalled  bool
	deadlineSet        bool
	queryMessages      []string
	multiResults       []connection.ResultSetData
	multiMessages      []string
}

type fakeAgentElasticsearchConsoleDB struct {
	fakeAgentTimeoutDB
	request  db.ElasticsearchConsoleRequest
	response db.ElasticsearchConsoleResponse
}

type fakeAgentTableExistsDB struct {
	fakeAgentTimeoutDB
	dbName    string
	tableName string
	exists    bool
}

type fakeAgentTableListDB struct {
	fakeAgentTimeoutDB
	dbName string
	tables []string
}

type fakeAgentSSHRuntimeDB struct {
	fakeAgentTimeoutDB
	connectConfig   connection.ConnectionConfig
	connectErr      error
	connectProgress []connection.SSHProgressEvent
}

type fakeAgentApplyChangesDB struct {
	fakeAgentTimeoutDB
	applyErr error
}

func (f *fakeAgentApplyChangesDB) ApplyChanges(string, connection.ChangeSet) error {
	return f.applyErr
}

func TestHandleRequestApplyChangesEncodesUnknownWriteOutcome(t *testing.T) {
	runtimeState := &agentRuntime{
		inst:     &fakeAgentApplyChangesDB{applyErr: db.MarkWriteOutcomeUnknown(errors.New("response lost"))},
		sessions: make(map[string]db.StatementExecer),
	}
	changes := connection.ChangeSet{Inserts: []map[string]interface{}{{"id": 1}}}
	resp := handleRequest(runtimeState, agentRequest{ID: 11, Method: agentMethodApplyChanges, TableName: "items", Changes: &changes})
	if resp.Success || !resp.OutcomeUnknown || resp.Error != "response lost" {
		t.Fatalf("applyChanges response = %#v", resp)
	}
}

func (f *fakeAgentSSHRuntimeDB) Connect(config connection.ConnectionConfig) error {
	f.connectConfig = config
	for _, event := range f.connectProgress {
		config.SSH.ReportProgress(event.Stage, event.Status)
	}
	return f.connectErr
}

func (f *fakeAgentTableExistsDB) TableExists(dbName, tableName string) (bool, error) {
	f.dbName = dbName
	f.tableName = tableName
	return f.exists, nil
}

func (f *fakeAgentTableListDB) GetTables(dbName string) ([]string, error) {
	f.dbName = dbName
	return append([]string(nil), f.tables...), nil
}

func (f *fakeAgentElasticsearchConsoleDB) ExecuteElasticsearchConsoleRequest(_ context.Context, request db.ElasticsearchConsoleRequest) (db.ElasticsearchConsoleResponse, error) {
	f.request = request
	return f.response, nil
}

func (f *fakeAgentElasticsearchConsoleDB) ElasticsearchServerMajor() int { return 8 }

func (f *fakeAgentTimeoutDB) Connect(config connection.ConnectionConfig) error { return nil }
func (f *fakeAgentTimeoutDB) Close() error                                     { return nil }
func (f *fakeAgentTimeoutDB) Ping() error                                      { return nil }
func (f *fakeAgentTimeoutDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryCalled = true
	return nil, nil, errors.New("query should not be called")
}
func (f *fakeAgentTimeoutDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.queryContextCalled = true
	if _, ok := ctx.Deadline(); ok {
		f.deadlineSet = true
	}
	return []map[string]interface{}{{"ok": 1}}, []string{"ok"}, nil
}
func (f *fakeAgentTimeoutDB) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	data, fields, err := f.QueryContext(context.Background(), query)
	return data, fields, append([]string(nil), f.queryMessages...), err
}
func (f *fakeAgentTimeoutDB) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	data, fields, err := f.QueryContext(ctx, query)
	return data, fields, append([]string(nil), f.queryMessages...), err
}
func (f *fakeAgentTimeoutDB) Exec(query string) (int64, error) {
	f.execCalled = true
	return 0, errors.New("exec should not be called")
}
func (f *fakeAgentTimeoutDB) ExecContext(ctx context.Context, query string) (int64, error) {
	f.execContextCalled = true
	if _, ok := ctx.Deadline(); ok {
		f.deadlineSet = true
	}
	return 3, nil
}
func (f *fakeAgentTimeoutDB) GetDatabases() ([]string, error) { return nil, nil }
func (f *fakeAgentTimeoutDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (f *fakeAgentTimeoutDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (f *fakeAgentTimeoutDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (f *fakeAgentTimeoutDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeAgentTimeoutDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *fakeAgentTimeoutDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeAgentTimeoutDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}
func (f *fakeAgentTimeoutDB) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	return append([]connection.ResultSetData(nil), f.multiResults...), append([]string(nil), f.multiMessages...), nil
}
func (f *fakeAgentTimeoutDB) QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error) {
	if _, ok := ctx.Deadline(); ok {
		f.deadlineSet = true
	}
	return f.QueryMultiWithMessages(query)
}

type fakeAgentSessionDB struct {
	fakeAgentTimeoutDB
	session *fakeAgentStatementSession
}

type fakeAgentTransactionDB struct {
	fakeAgentTimeoutDB
	transaction *fakeAgentTransactionSession
}

func (f *fakeAgentTransactionDB) OpenTransactionExecer(context.Context) (db.TransactionExecer, error) {
	f.transaction = &fakeAgentTransactionSession{}
	return f.transaction, nil
}

type fakeAgentTransactionSession struct {
	fakeAgentStatementSession
	commitCalls   int
	rollbackCalls int
}

func (f *fakeAgentTransactionSession) Commit() error {
	f.commitCalls++
	return nil
}

func (f *fakeAgentTransactionSession) Rollback() error {
	f.rollbackCalls++
	return nil
}

func (f *fakeAgentSessionDB) OpenSessionExecer(ctx context.Context) (db.StatementExecer, error) {
	f.session = &fakeAgentStatementSession{}
	return f.session, nil
}

type fakeAgentStatementSession struct {
	queryCalls int
	execCalls  int
	closed     bool
	messages   []string
}

func (f *fakeAgentStatementSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return f.QueryContext(context.Background(), query)
}

func (f *fakeAgentStatementSession) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.queryCalls++
	return []map[string]interface{}{{"session_ok": 1}}, []string{"session_ok"}, nil
}
func (f *fakeAgentStatementSession) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	data, fields, err := f.QueryContext(context.Background(), query)
	return data, fields, append([]string(nil), f.messages...), err
}
func (f *fakeAgentStatementSession) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	data, fields, err := f.QueryContext(ctx, query)
	return data, fields, append([]string(nil), f.messages...), err
}

func (f *fakeAgentStatementSession) Exec(query string) (int64, error) {
	return f.ExecContext(context.Background(), query)
}

func (f *fakeAgentStatementSession) ExecContext(ctx context.Context, query string) (int64, error) {
	f.execCalls++
	return 9, nil
}

func (f *fakeAgentStatementSession) Close() error {
	f.closed = true
	return nil
}

type fakeAgentStreamSession struct {
	closed      bool
	streamCalls int
	deadlineSet bool
}

func (f *fakeAgentStreamSession) Exec(query string) (int64, error) {
	return 0, nil
}

func (f *fakeAgentStreamSession) ExecContext(ctx context.Context, query string) (int64, error) {
	return 0, nil
}

func (f *fakeAgentStreamSession) Close() error {
	f.closed = true
	return nil
}

func (f *fakeAgentStreamSession) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *fakeAgentStreamSession) StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.streamCalls++
	if _, ok := ctx.Deadline(); ok {
		f.deadlineSet = true
	}
	if err := consumer.SetColumns([]string{"id", "name"}); err != nil {
		return err
	}
	if valueConsumer, ok := consumer.(db.QueryStreamValueConsumer); ok {
		if err := valueConsumer.ConsumeRowValues([]interface{}{1, "alice"}); err != nil {
			return err
		}
		if err := valueConsumer.ConsumeRowValues([]interface{}{2, "bob"}); err != nil {
			return err
		}
		return nil
	}
	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1, "name": "alice"}); err != nil {
		return err
	}
	return consumer.ConsumeRow(map[string]interface{}{"id": 2, "name": "bob"})
}

type fakeAgentSessionStreamDB struct {
	fakeAgentTimeoutDB
	session   *fakeAgentStreamSession
	openCalls int
}

func (f *fakeAgentSessionStreamDB) OpenSessionExecer(ctx context.Context) (db.StatementExecer, error) {
	f.openCalls++
	f.session = &fakeAgentStreamSession{}
	return f.session, nil
}

func TestQueryWithOptionalTimeout_UsesQueryContext(t *testing.T) {
	fake := &fakeAgentTimeoutDB{}
	data, fields, err := queryWithOptionalTimeout(fake, "SELECT 1", int64((2 * time.Second).Milliseconds()))
	if err != nil {
		t.Fatalf("queryWithOptionalTimeout 返回错误: %v", err)
	}
	if !fake.queryContextCalled || fake.queryCalled {
		t.Fatalf("query 调用路径异常，QueryContext=%v Query=%v", fake.queryContextCalled, fake.queryCalled)
	}
	if !fake.deadlineSet {
		t.Fatal("queryWithOptionalTimeout 未设置 deadline")
	}
	if len(data) != 1 || len(fields) != 1 || fields[0] != "ok" {
		t.Fatalf("queryWithOptionalTimeout 返回数据异常: data=%v fields=%v", data, fields)
	}
}

func TestExecWithOptionalTimeout_UsesExecContext(t *testing.T) {
	fake := &fakeAgentTimeoutDB{}
	affected, err := execWithOptionalTimeout(fake, "DELETE FROM t", int64((2 * time.Second).Milliseconds()))
	if err != nil {
		t.Fatalf("execWithOptionalTimeout 返回错误: %v", err)
	}
	if !fake.execContextCalled || fake.execCalled {
		t.Fatalf("exec 调用路径异常，ExecContext=%v Exec=%v", fake.execContextCalled, fake.execCalled)
	}
	if !fake.deadlineSet {
		t.Fatal("execWithOptionalTimeout 未设置 deadline")
	}
	if affected != 3 {
		t.Fatalf("受影响行数异常，want=3 got=%d", affected)
	}
}

func TestQueryWithOptionalTimeout_ClickHouseLegacyModeUsesQueryContext(t *testing.T) {
	old := agentDriverType
	agentDriverType = "clickhouse"
	defer func() { agentDriverType = old }()

	fake := &fakeAgentTimeoutDB{}
	_, _, err := queryWithOptionalTimeout(fake, "SELECT 1", 0)
	if err != nil {
		t.Fatalf("queryWithOptionalTimeout 返回错误: %v", err)
	}
	if !fake.queryContextCalled || fake.queryCalled {
		t.Fatalf("clickhouse legacy query 调用路径异常，QueryContext=%v Query=%v", fake.queryContextCalled, fake.queryCalled)
	}
}

func TestHandleRequest_QueryIncludesServerMessages(t *testing.T) {
	old := agentDriverType
	defer func() { agentDriverType = old }()
	agentDriverType = "sqlserver"

	fake := &fakeAgentTimeoutDB{
		queryMessages: []string{"PRINT sql line 1", "PRINT sql line 2"},
	}
	runtimeState := &agentRuntime{inst: fake, sessions: make(map[string]db.StatementExecer)}

	resp := handleRequest(runtimeState, agentRequest{
		ID:        11,
		Method:    agentMethodQuery,
		Query:     "exec dbo.p_get_select",
		TimeoutMs: int64((2 * time.Second).Milliseconds()),
	})
	if !resp.Success {
		t.Fatalf("query request failed: %s", resp.Error)
	}
	if len(resp.Messages) != 2 || resp.Messages[0] != "PRINT sql line 1" {
		t.Fatalf("expected query messages to be preserved, got %#v", resp.Messages)
	}
}

func TestHandleRequest_ExecutesElasticsearchConsoleRequest(t *testing.T) {
	fake := &fakeAgentElasticsearchConsoleDB{
		response: db.ElasticsearchConsoleResponse{
			StatusCode:  http.StatusBadRequest,
			ContentType: "application/json",
			RawBody:     `{"error":{"type":"parsing_exception"},"status":400}`,
			ServerMajor: 8,
		},
	}
	runtimeState := &agentRuntime{inst: fake, sessions: make(map[string]db.StatementExecer)}
	request := db.ElasticsearchConsoleRequest{
		Method:   http.MethodPost,
		Path:     "/orders/_search",
		Body:     `{"query":`,
		BodyKind: db.ElasticsearchConsoleBodyKindJSON,
	}

	response := handleRequest(runtimeState, agentRequest{
		ID:                   21,
		Method:               agentMethodElasticsearchConsole,
		ElasticsearchRequest: &request,
		TimeoutMs:            int64((2 * time.Second).Milliseconds()),
	})
	if !response.Success {
		t.Fatalf("console request failed: %s", response.Error)
	}
	if fake.request != request {
		t.Fatalf("request was not preserved: %#v", fake.request)
	}
	got, ok := response.Data.(db.ElasticsearchConsoleResponse)
	if !ok {
		t.Fatalf("unexpected response type: %T", response.Data)
	}
	if got != fake.response {
		t.Fatalf("response was not preserved: %#v", got)
	}
}

func TestHandleRequest_TableExistsUsesDriverCapability(t *testing.T) {
	fake := &fakeAgentTableExistsDB{exists: true}
	runtimeState := &agentRuntime{inst: fake, sessions: make(map[string]db.StatementExecer)}

	response := handleRequest(runtimeState, agentRequest{
		ID:        24,
		Method:    agentMethodTableExists,
		DBName:    "analytics",
		TableName: "orders-2026",
	})
	if !response.Success {
		t.Fatalf("table existence request failed: %s", response.Error)
	}
	if fake.dbName != "analytics" || fake.tableName != "orders-2026" {
		t.Fatalf("driver capability received %q.%q", fake.dbName, fake.tableName)
	}
	exists, ok := response.Data.(bool)
	if !ok || !exists {
		t.Fatalf("unexpected existence response: %#v", response.Data)
	}
}

func TestHandleRequest_TableExistsFallsBackToExactTableList(t *testing.T) {
	tests := []struct {
		name      string
		tableName string
		want      bool
	}{
		{name: "exact qualified name", tableName: "dbo.users", want: true},
		{name: "other schema", tableName: "public.users", want: false},
		{name: "different case", tableName: "audit.users", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeAgentTableListDB{tables: []string{"dbo.users", "audit.Users"}}
			runtimeState := &agentRuntime{inst: fake, sessions: make(map[string]db.StatementExecer)}

			response := handleRequest(runtimeState, agentRequest{
				ID:        25,
				Method:    agentMethodTableExists,
				DBName:    "main",
				TableName: test.tableName,
			})
			if !response.Success {
				t.Fatalf("fallback table existence request failed: %s", response.Error)
			}
			if fake.dbName != "main" {
				t.Fatalf("GetTables received database %q", fake.dbName)
			}
			exists, ok := response.Data.(bool)
			if !ok || exists != test.want {
				t.Fatalf("fallback existence response = %#v, want %v", response.Data, test.want)
			}
		})
	}
}

func TestHandleRequest_ConnectReturnsElasticsearchServerMajor(t *testing.T) {
	previousFactory := agentDatabaseFactory
	previousDriverType := agentDriverType
	t.Cleanup(func() {
		agentDatabaseFactory = previousFactory
		agentDriverType = previousDriverType
	})

	fake := &fakeAgentElasticsearchConsoleDB{}
	agentDriverType = "elasticsearch"
	agentDatabaseFactory = func() db.Database { return fake }
	runtimeState := &agentRuntime{sessions: make(map[string]db.StatementExecer)}
	config := connection.ConnectionConfig{Type: "elasticsearch"}

	response := handleRequest(runtimeState, agentRequest{
		ID:     23,
		Method: agentMethodConnect,
		Config: &config,
	})
	if !response.Success {
		t.Fatalf("connect request failed: %s", response.Error)
	}
	info, ok := response.Data.(agentConnectionInfo)
	if !ok {
		t.Fatalf("unexpected connection info type: %T", response.Data)
	}
	if info.ElasticsearchServerMajor != 8 {
		t.Fatalf("unexpected Elasticsearch server major: %d", info.ElasticsearchServerMajor)
	}
}

func TestHandleRequest_ConnectRestoresSSHRuntimeAndReportsTrustStatus(t *testing.T) {
	previousFactory := agentDatabaseFactory
	previousDriverType := agentDriverType
	t.Cleanup(func() {
		agentDatabaseFactory = previousFactory
		agentDriverType = previousDriverType
	})

	status := sshbridge.HostKeyTrustStatus{
		State:       "unknown",
		Source:      "discovered",
		Host:        "bastion.example.test",
		Port:        37167,
		Address:     "bastion.example.test:37167",
		KeyType:     "ssh-ed25519",
		Fingerprint: "SHA256:server-key",
	}
	fake := &fakeAgentSSHRuntimeDB{connectErr: &sshbridge.HostKeyTrustRequiredError{Status: status}}
	agentDriverType = "kingbase"
	agentDatabaseFactory = func() db.Database { return fake }

	config := connection.ConnectionConfig{
		Type:   "kingbase",
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "127.0.0.1",
			Port: 37167,
		}.WithManagedHostKeyTrustStore("/private/gonavi/ssh/host_keys.json").
			WithHostKeyIdentity("bastion.example.test", 37167),
	}
	request := agentRequest{
		ID:         99,
		Method:     agentMethodConnect,
		Config:     &config,
		SSHRuntime: config.SSH.RuntimeSnapshot(),
	}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal agent request: %v", err)
	}
	var decoded agentRequest
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal agent request: %v", err)
	}
	if got := decoded.Config.SSH.ManagedHostKeyTrustStorePath(); got != "" {
		t.Fatalf("serialized config unexpectedly kept managed trust-store path: %q", got)
	}

	response := handleRequest(&agentRuntime{sessions: make(map[string]db.StatementExecer)}, decoded)
	if response.Success {
		t.Fatal("expected SSH host-key trust confirmation response")
	}
	if got := fake.connectConfig.SSH.ManagedHostKeyTrustStorePath(); got != "/private/gonavi/ssh/host_keys.json" {
		t.Fatalf("agent did not restore managed trust-store path: %q", got)
	}
	if host, port := fake.connectConfig.SSH.HostKeyIdentity(); host != "bastion.example.test" || port != 37167 {
		t.Fatalf("agent did not restore logical host-key identity: %q:%d", host, port)
	}
	if response.SSHHostKeyTrust == nil || *response.SSHHostKeyTrust != status {
		t.Fatalf("agent trust response = %#v, want %#v", response.SSHHostKeyTrust, status)
	}
}

func TestServeAgentRequests_ConnectStreamsSSHProgress(t *testing.T) {
	previousFactory := agentDatabaseFactory
	previousDriverType := agentDriverType
	t.Cleanup(func() {
		agentDatabaseFactory = previousFactory
		agentDriverType = previousDriverType
	})

	fake := &fakeAgentSSHRuntimeDB{connectProgress: []connection.SSHProgressEvent{
		{Stage: "tcp_connecting", Status: "running"},
		{Stage: "tcp_connected", Status: "success"},
		{Stage: "host_key_verifying", Status: "running"},
		{Stage: "host_key_verified", Status: "success"},
		{Stage: "authenticating", Status: "running"},
		{Stage: "authenticated", Status: "success"},
		{Stage: "tunnel_creating", Status: "running"},
		{Stage: "tunnel_ready", Status: "success"},
	}}
	agentDriverType = "kingbase"
	agentDatabaseFactory = func() db.Database { return fake }

	config := connection.ConnectionConfig{
		Type:   "kingbase",
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.test",
			Port: 22,
		},
	}
	request, err := json.Marshal(agentRequest{
		ID:                73,
		Method:            agentMethodConnect,
		Config:            &config,
		StreamSSHProgress: true,
	})
	if err != nil {
		t.Fatalf("marshal connect request: %v", err)
	}

	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := serveAgentRequests(bytes.NewReader(append(request, '\n')), writer, &agentRuntime{sessions: make(map[string]db.StatementExecer)}); err != nil {
		t.Fatalf("serve agent requests: %v", err)
	}

	var responses []agentResponse
	scanner := bufio.NewScanner(bytes.NewReader(output.Bytes()))
	for scanner.Scan() {
		var response agentResponse
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			t.Fatalf("decode agent response: %v", err)
		}
		responses = append(responses, response)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("read agent responses: %v", err)
	}

	if len(responses) != len(fake.connectProgress)+1 {
		t.Fatalf("agent response frames = %d, want %d progress frames plus final response", len(responses), len(fake.connectProgress)+1)
	}
	for index, response := range responses {
		if response.ID != 73 {
			t.Fatalf("response frame %d request ID = %d, want 73", index, response.ID)
		}
	}
	for index, want := range fake.connectProgress {
		if responses[index].SSHProgress == nil || *responses[index].SSHProgress != want {
			t.Fatalf("progress response %d = %#v, want %#v", index, responses[index].SSHProgress, want)
		}
	}
	final := responses[len(responses)-1]
	if !final.Success || final.SSHProgress != nil {
		t.Fatalf("final connect response = %#v, want successful non-progress response", final)
	}
}

func TestServeAgentRequests_ConnectKeepsLegacySingleResponseWithoutProgressSubscription(t *testing.T) {
	previousFactory := agentDatabaseFactory
	previousDriverType := agentDriverType
	t.Cleanup(func() {
		agentDatabaseFactory = previousFactory
		agentDriverType = previousDriverType
	})

	fake := &fakeAgentSSHRuntimeDB{connectProgress: []connection.SSHProgressEvent{
		{Stage: "tcp_connecting", Status: "running"},
		{Stage: "tcp_connected", Status: "success"},
	}}
	agentDriverType = "kingbase"
	agentDatabaseFactory = func() db.Database { return fake }

	config := connection.ConnectionConfig{
		Type:   "kingbase",
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.test",
			Port: 22,
		},
	}
	request, err := json.Marshal(agentRequest{
		ID:     74,
		Method: agentMethodConnect,
		Config: &config,
	})
	if err != nil {
		t.Fatalf("marshal legacy connect request: %v", err)
	}

	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := serveAgentRequests(bytes.NewReader(append(request, '\n')), writer, &agentRuntime{sessions: make(map[string]db.StatementExecer)}); err != nil {
		t.Fatalf("serve legacy agent request: %v", err)
	}

	var responses []agentResponse
	scanner := bufio.NewScanner(bytes.NewReader(output.Bytes()))
	for scanner.Scan() {
		var response agentResponse
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			t.Fatalf("decode legacy agent response: %v", err)
		}
		responses = append(responses, response)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("read legacy agent responses: %v", err)
	}

	if len(responses) != 1 {
		t.Fatalf("legacy connect response frames = %d, want exactly final response", len(responses))
	}
	if !responses[0].Success || responses[0].SSHProgress != nil {
		t.Fatalf("legacy final connect response = %#v, want successful non-progress response", responses[0])
	}
}

func TestHandleRequest_RejectsElasticsearchConsoleForUnsupportedDriver(t *testing.T) {
	fake := &fakeAgentTimeoutDB{}
	runtimeState := &agentRuntime{inst: fake, sessions: make(map[string]db.StatementExecer)}
	request := db.ElasticsearchConsoleRequest{
		Method:   http.MethodGet,
		Path:     "/_cluster/health",
		BodyKind: db.ElasticsearchConsoleBodyKindNone,
	}

	response := handleRequest(runtimeState, agentRequest{
		ID:                   22,
		Method:               agentMethodElasticsearchConsole,
		ElasticsearchRequest: &request,
	})
	if response.Success {
		t.Fatal("unsupported driver must reject Elasticsearch Console requests")
	}
	if !strings.Contains(response.Error, "不支持 Elasticsearch Console") {
		t.Fatalf("unexpected capability error: %q", response.Error)
	}
}

func TestHandleRequest_QueryMultiIncludesResultSetsAndMessages(t *testing.T) {
	old := agentDriverType
	defer func() { agentDriverType = old }()
	agentDriverType = "sqlserver"

	fake := &fakeAgentTimeoutDB{
		multiResults: []connection.ResultSetData{
			{
				StatementIndex: 1,
				Rows:           []map[string]interface{}{{"name": "master"}},
				Columns:        []string{"name"},
			},
			{
				StatementIndex: 1,
				Rows:           []map[string]interface{}{},
				Columns:        []string{},
				Messages:       []string{"PRINT generated sql"},
			},
		},
		multiMessages: []string{"batch top-level message"},
	}
	runtimeState := &agentRuntime{inst: fake, sessions: make(map[string]db.StatementExecer)}

	resp := handleRequest(runtimeState, agentRequest{
		ID:        12,
		Method:    agentMethodQueryMulti,
		Query:     "exec dbo.p_get_select",
		TimeoutMs: int64((2 * time.Second).Milliseconds()),
	})
	if !resp.Success {
		t.Fatalf("queryMulti request failed: %s", resp.Error)
	}
	if len(resp.Messages) != 1 || resp.Messages[0] != "batch top-level message" {
		t.Fatalf("expected top-level messages to be preserved, got %#v", resp.Messages)
	}
	resultSets, ok := resp.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", resp.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected 2 result sets, got %#v", resultSets)
	}
	if len(resultSets[1].Messages) != 1 || resultSets[1].Messages[0] != "PRINT generated sql" {
		t.Fatalf("expected message-only result set to be preserved, got %#v", resultSets[1])
	}
}

func TestHandleRequest_UsesPinnedSessionForSessionScopedQueryAndExec(t *testing.T) {
	old := agentDriverType
	defer func() { agentDriverType = old }()
	agentDriverType = "sqlserver"

	fake := &fakeAgentSessionDB{}
	runtimeState := &agentRuntime{
		inst:     fake,
		sessions: make(map[string]db.StatementExecer),
	}

	openResp := handleRequest(runtimeState, agentRequest{ID: 1, Method: agentMethodOpenSession})
	if !openResp.Success {
		t.Fatalf("openSession failed: %s", openResp.Error)
	}
	sessionID, ok := openResp.Data.(string)
	if !ok || strings.TrimSpace(sessionID) == "" {
		t.Fatalf("unexpected session id payload: %#v", openResp.Data)
	}
	if fake.session == nil {
		t.Fatal("expected OpenSessionExecer to create a pinned session")
	}

	queryResp := handleRequest(runtimeState, agentRequest{
		ID:        2,
		Method:    agentMethodQuery,
		SessionID: sessionID,
		Query:     "SELECT 1",
	})
	if !queryResp.Success {
		t.Fatalf("session query failed: %s", queryResp.Error)
	}
	if len(queryResp.Messages) != 0 {
		t.Fatalf("expected empty default session messages, got %#v", queryResp.Messages)
	}
	if fake.queryCalled || fake.queryContextCalled {
		t.Fatalf("expected session query to bypass database-level query path, got Query=%v QueryContext=%v", fake.queryCalled, fake.queryContextCalled)
	}
	if fake.session.queryCalls != 1 {
		t.Fatalf("expected pinned session queryCalls=1, got %d", fake.session.queryCalls)
	}

	execResp := handleRequest(runtimeState, agentRequest{
		ID:        3,
		Method:    agentMethodExec,
		SessionID: sessionID,
		Query:     "UPDATE t SET v = 1",
	})
	if !execResp.Success {
		t.Fatalf("session exec failed: %s", execResp.Error)
	}
	if fake.execCalled || fake.execContextCalled {
		t.Fatalf("expected session exec to bypass database-level exec path, got Exec=%v ExecContext=%v", fake.execCalled, fake.execContextCalled)
	}
	if fake.session.execCalls != 1 {
		t.Fatalf("expected pinned session execCalls=1, got %d", fake.session.execCalls)
	}

	closeResp := handleRequest(runtimeState, agentRequest{
		ID:        4,
		Method:    agentMethodCloseSession,
		SessionID: sessionID,
	})
	if !closeResp.Success {
		t.Fatalf("closeSession failed: %s", closeResp.Error)
	}
	if !fake.session.closed {
		t.Fatal("expected pinned session to close")
	}
}

func TestHandleRequest_UsesManagedTransactionSession(t *testing.T) {
	for _, tc := range []struct {
		name          string
		finishMethod  string
		wantCommits   int
		wantRollbacks int
	}{
		{name: "commit", finishMethod: "commitTransaction", wantCommits: 1},
		{name: "rollback", finishMethod: "rollbackTransaction", wantRollbacks: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeAgentTransactionDB{}
			runtimeState := &agentRuntime{
				inst:     fake,
				sessions: make(map[string]db.StatementExecer),
			}

			openResp := handleRequest(runtimeState, agentRequest{ID: 1, Method: "openTransaction"})
			if !openResp.Success {
				t.Fatalf("openTransaction failed: %s", openResp.Error)
			}
			sessionID, ok := openResp.Data.(string)
			if !ok || strings.TrimSpace(sessionID) == "" {
				t.Fatalf("unexpected transaction id payload: %#v", openResp.Data)
			}

			execResp := handleRequest(runtimeState, agentRequest{
				ID:        2,
				Method:    agentMethodExec,
				SessionID: sessionID,
				Query:     "UPDATE t SET v = 1",
			})
			if !execResp.Success {
				t.Fatalf("transaction exec failed: %s", execResp.Error)
			}

			finishResp := handleRequest(runtimeState, agentRequest{
				ID:        3,
				Method:    tc.finishMethod,
				SessionID: sessionID,
			})
			if !finishResp.Success {
				t.Fatalf("%s failed: %s", tc.finishMethod, finishResp.Error)
			}
			closeResp := handleRequest(runtimeState, agentRequest{
				ID:        4,
				Method:    agentMethodCloseSession,
				SessionID: sessionID,
			})
			if !closeResp.Success {
				t.Fatalf("closeSession failed: %s", closeResp.Error)
			}
			if fake.transaction == nil || !fake.transaction.closed {
				t.Fatal("expected managed transaction session to close")
			}
			if fake.transaction.commitCalls != tc.wantCommits || fake.transaction.rollbackCalls != tc.wantRollbacks {
				t.Fatalf(
					"unexpected finish calls: commit=%d rollback=%d",
					fake.transaction.commitCalls,
					fake.transaction.rollbackCalls,
				)
			}
		})
	}
}

func TestHandleStreamRequest_UsesSessionStreamerAndWritesChunks(t *testing.T) {
	old := agentDriverType
	originalAsync := runAgentMemoryTrimAsync
	originalTrim := agentMemoryTrimFn
	originalLastAt := agentMemoryTrimLastAt.Load()
	defer func() { agentDriverType = old }()
	defer func() {
		runAgentMemoryTrimAsync = originalAsync
		agentMemoryTrimFn = originalTrim
		agentMemoryTrimRunning.Store(false)
		agentMemoryTrimLastAt.Store(originalLastAt)
	}()
	agentDriverType = "oceanbase"
	agentMemoryTrimRunning.Store(false)
	agentMemoryTrimLastAt.Store(0)

	fake := &fakeAgentSessionStreamDB{}
	runtimeState := &agentRuntime{
		inst:     fake,
		sessions: make(map[string]db.StatementExecer),
	}

	trimmed := 0
	runAgentMemoryTrimAsync = func(fn func()) {
		fn()
	}
	agentMemoryTrimFn = func() {
		trimmed++
	}

	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	if err := handleStreamRequest(runtimeState, agentRequest{
		ID:        9,
		Method:    agentMethodStreamQuery,
		Query:     "SELECT * FROM person_info",
		TimeoutMs: int64((2 * time.Second).Milliseconds()),
	}, writer); err != nil {
		t.Fatalf("handleStreamRequest 返回错误: %v", err)
	}

	if fake.openCalls != 1 {
		t.Fatalf("expected OpenSessionExecer called once, got %d", fake.openCalls)
	}
	if fake.session == nil || fake.session.streamCalls != 1 {
		t.Fatalf("expected session streamer used once, session=%#v", fake.session)
	}
	if !fake.session.deadlineSet {
		t.Fatal("expected stream query context deadline to be set")
	}
	if !fake.session.closed {
		t.Fatal("expected session to close after streaming")
	}
	if fake.queryCalled || fake.queryContextCalled {
		t.Fatalf("unexpected fallback query path, Query=%v QueryContext=%v", fake.queryCalled, fake.queryContextCalled)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 stream responses, got %d: %q", len(lines), out.String())
	}

	var columnsResp struct {
		Success   bool     `json:"success"`
		ChunkType string   `json:"chunkType"`
		Fields    []string `json:"fields"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &columnsResp); err != nil {
		t.Fatalf("decode columns response failed: %v", err)
	}
	if !columnsResp.Success || columnsResp.ChunkType != agentChunkColumns || len(columnsResp.Fields) != 2 {
		t.Fatalf("unexpected columns response: %#v", columnsResp)
	}

	var rowsResp struct {
		Success   bool            `json:"success"`
		ChunkType string          `json:"chunkType"`
		Data      [][]interface{} `json:"data"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &rowsResp); err != nil {
		t.Fatalf("decode rows response failed: %v", err)
	}
	if !rowsResp.Success || rowsResp.ChunkType != agentChunkRows || len(rowsResp.Data) != 2 {
		t.Fatalf("unexpected rows response: %#v", rowsResp)
	}
	if got := rowsResp.Data[1][1]; got != "bob" {
		t.Fatalf("unexpected streamed row payload: %v", rowsResp.Data)
	}

	var doneResp struct {
		Success   bool   `json:"success"`
		ChunkType string `json:"chunkType"`
	}
	if err := json.Unmarshal([]byte(lines[2]), &doneResp); err != nil {
		t.Fatalf("decode done response failed: %v", err)
	}
	if !doneResp.Success || doneResp.ChunkType != agentChunkDone {
		t.Fatalf("unexpected done response: %#v", doneResp)
	}
	if trimmed != 0 {
		t.Fatalf("小流式任务不应触发内存回收，got=%d", trimmed)
	}
}

func TestMaybeReleaseAgentMemory_TriggersTrimForLargeJobs(t *testing.T) {
	originalAsync := runAgentMemoryTrimAsync
	originalTrim := agentMemoryTrimFn
	originalLastAt := agentMemoryTrimLastAt.Load()
	t.Cleanup(func() {
		runAgentMemoryTrimAsync = originalAsync
		agentMemoryTrimFn = originalTrim
		agentMemoryTrimRunning.Store(false)
		agentMemoryTrimLastAt.Store(originalLastAt)
	})

	agentMemoryTrimRunning.Store(false)
	agentMemoryTrimLastAt.Store(0)
	triggered := 0
	runAgentMemoryTrimAsync = func(fn func()) {
		fn()
	}
	agentMemoryTrimFn = func() {
		triggered++
	}

	maybeReleaseAgentMemory("test-large-query", agentMemoryTrimRowsThreshold)

	if triggered != 1 {
		t.Fatalf("大查询完成后应触发一次内存回收，got=%d", triggered)
	}
}
