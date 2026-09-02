package db

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestMain(m *testing.M) {
	if os.Getenv("GONAVI_MYSQL_AGENT_TEST_HELPER") == "1" {
		runMySQLAgentTestHelper()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runMySQLAgentTestHelper() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 16<<10), 8<<20)
	writer := bufio.NewWriter(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			continue
		}
		if request.Method == mysqlAgentMethodQuery && os.Getenv("GONAVI_MYSQL_AGENT_TEST_HELPER_HANG_QUERY") == "1" {
			time.Sleep(time.Hour)
			return
		}
		response := mysqlAgentResponse{ID: request.ID, Success: true}
		switch request.Method {
		case mysqlAgentMethodQuery:
			response.Data = json.RawMessage(`[{"answer":7}]`)
			response.Fields = []string{"answer"}
		case mysqlAgentMethodExec:
			response.RowsAffected = 1
		}
		payload, err := json.Marshal(response)
		if err != nil {
			return
		}
		if _, err := writer.Write(append(payload, '\n')); err != nil {
			return
		}
		if err := writer.Flush(); err != nil {
			return
		}
	}
}

type mysqlAgentBlockingTransport struct {
	mu           sync.Mutex
	writes       bytes.Buffer
	readStarted  chan struct{}
	closed       chan struct{}
	readFinished chan struct{}
	startOnce    sync.Once
	closeOnce    sync.Once
	finishOnce   sync.Once
}

func newMySQLAgentBlockingTransport() *mysqlAgentBlockingTransport {
	return &mysqlAgentBlockingTransport{
		readStarted:  make(chan struct{}),
		closed:       make(chan struct{}),
		readFinished: make(chan struct{}),
	}
}

func (t *mysqlAgentBlockingTransport) Write(payload []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.writes.Write(payload)
}

func (t *mysqlAgentBlockingTransport) Read([]byte) (int, error) {
	t.startOnce.Do(func() { close(t.readStarted) })
	<-t.closed
	t.finishOnce.Do(func() { close(t.readFinished) })
	return 0, io.ErrClosedPipe
}

func (t *mysqlAgentBlockingTransport) Close() error {
	t.closeOnce.Do(func() { close(t.closed) })
	return nil
}

type mysqlAgentTestWriteCloser struct {
	bytes.Buffer
}

func (w *mysqlAgentTestWriteCloser) Close() error { return nil }

type mysqlAgentSignalingWriteCloser struct {
	writes chan []byte
}

func (w *mysqlAgentSignalingWriteCloser) Write(payload []byte) (int, error) {
	writes := append([]byte(nil), payload...)
	w.writes <- writes
	return len(payload), nil
}

func (w *mysqlAgentSignalingWriteCloser) Close() error { return nil }

func TestMySQLAgentQueryContextStopsUnresponsiveTransport(t *testing.T) {
	transport := newMySQLAgentBlockingTransport()
	defer transport.Close()
	client := &mysqlAgentClient{
		stdin:  transport,
		reader: bufio.NewReader(transport),
	}
	dbInst := &MySQLAgentDB{client: client}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, _, err := dbInst.QueryContext(ctx, "SELECT 1")
		result <- err
	}()

	select {
	case <-transport.readStarted:
	case <-time.After(time.Second):
		t.Fatal("MySQL agent call did not start reading its response")
	}

	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expected context deadline error, got %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("QueryContext remained blocked after its context deadline")
	}

	select {
	case <-transport.readFinished:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed-out MySQL agent read remained blocked")
	}
	if !errors.Is(client.stoppedError(), errMySQLAgentTransportStopped) {
		t.Fatalf("cancelled client state = %v, want stopped transport", client.stoppedError())
	}
	startedAt := time.Now()
	if err := client.call(mysqlAgentRequest{Method: mysqlAgentMethodPing}, nil, nil, nil); !errors.Is(err, errMySQLAgentTransportStopped) {
		t.Fatalf("cancelled client reuse error = %v, want stopped transport", err)
	} else if elapsed := time.Since(startedAt); elapsed > 50*time.Millisecond {
		t.Fatalf("cancelled client reuse took %s", elapsed)
	}
}

func TestMySQLAgentExecContextStopsUnresponsiveTransport(t *testing.T) {
	transport := newMySQLAgentBlockingTransport()
	defer transport.Close()
	client := &mysqlAgentClient{
		stdin:  transport,
		reader: bufio.NewReader(transport),
	}
	dbInst := &MySQLAgentDB{client: client}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := dbInst.ExecContext(ctx, "UPDATE demo SET value = 1")
		result <- err
	}()

	select {
	case <-transport.readStarted:
	case <-time.After(time.Second):
		t.Fatal("MySQL agent call did not start reading its response")
	}
	cancel()

	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context cancellation error, got %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("ExecContext remained blocked after cancellation")
	}

	select {
	case <-transport.readFinished:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("cancelled MySQL agent read remained blocked")
	}
}

func TestMySQLAgentQueuedCancellationDoesNotDispatchOrTerminateActiveCall(t *testing.T) {
	stdin := &mysqlAgentSignalingWriteCloser{writes: make(chan []byte, 3)}
	stdoutReader, stdoutWriter := io.Pipe()
	defer stdoutReader.Close()
	defer stdoutWriter.Close()
	client := &mysqlAgentClient{
		stdin:  stdin,
		reader: bufio.NewReader(stdoutReader),
	}
	dbInst := &MySQLAgentDB{client: client}

	type queryResult struct {
		rows []map[string]interface{}
		err  error
	}
	queryDone := make(chan queryResult, 1)
	go func() {
		rows, _, err := dbInst.Query("SELECT slow_value")
		queryDone <- queryResult{rows: rows, err: err}
	}()

	select {
	case payload := <-stdin.writes:
		if !bytes.Contains(payload, []byte(`"method":"query"`)) {
			t.Fatalf("first request was not the long query: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("long query did not acquire the MySQL agent transport")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	execDone := make(chan error, 1)
	go func() {
		_, err := dbInst.ExecContext(ctx, "UPDATE demo SET value = 2")
		execDone <- err
	}()
	select {
	case err := <-execDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("queued ExecContext returned %v, want context deadline", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("queued ExecContext did not honor its context deadline")
	}

	select {
	case payload := <-stdin.writes:
		t.Fatalf("timed-out queued ExecContext was written to the agent: %s", payload)
	default:
	}

	if _, err := stdoutWriter.Write([]byte(`{"id":1,"success":true,"data":[{"slow_value":42}],"fields":["slow_value"]}` + "\n")); err != nil {
		t.Fatalf("write long query response: %v", err)
	}
	select {
	case result := <-queryDone:
		if result.err != nil {
			t.Fatalf("long query failed after queued cancellation: %v", result.err)
		}
		if len(result.rows) != 1 || result.rows[0]["slow_value"] != int64(42) {
			t.Fatalf("unexpected long query rows: %#v", result.rows)
		}
	case <-time.After(time.Second):
		t.Fatal("long query did not complete after its response")
	}

	pingDone := make(chan error, 1)
	go func() { pingDone <- client.call(mysqlAgentRequest{Method: mysqlAgentMethodPing}, nil, nil, nil) }()
	select {
	case payload := <-stdin.writes:
		if !bytes.Contains(payload, []byte(`"method":"ping"`)) {
			t.Fatalf("transport reuse request was not ping: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("transport was not reusable after queued cancellation")
	}
	if _, err := stdoutWriter.Write([]byte(`{"id":2,"success":true}` + "\n")); err != nil {
		t.Fatalf("write final ping response: %v", err)
	}
	select {
	case err := <-pingDone:
		if err != nil {
			t.Fatalf("reused transport ping failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("reused transport ping did not complete")
	}
}

func TestMySQLAgentFreshClientCanRecoverAfterCancelledRequest(t *testing.T) {
	transport := newMySQLAgentBlockingTransport()
	client := &mysqlAgentClient{
		stdin:  transport,
		reader: bufio.NewReader(transport),
	}
	dbInst := &MySQLAgentDB{client: client}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	queryDone := make(chan error, 1)
	go func() {
		_, _, err := dbInst.QueryContext(ctx, "SELECT cancelled")
		queryDone <- err
	}()
	select {
	case <-transport.readStarted:
	case <-time.After(time.Second):
		t.Fatal("cancelled query did not start")
	}
	select {
	case err := <-queryDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("cancelled query error = %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("cancelled query remained blocked")
	}
	_ = transport.Close()

	var freshStdin mysqlAgentTestWriteCloser
	freshClient := &mysqlAgentClient{
		stdin:  &freshStdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true,"data":[{"answer":7}],"fields":["answer"]}` + "\n")),
	}
	dbInst.setClient(freshClient)
	rows, fields, err := dbInst.Query("SELECT recovered")
	if err != nil {
		t.Fatalf("fresh client query failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["answer"] != int64(7) || len(fields) != 1 || fields[0] != "answer" {
		t.Fatalf("fresh client response = rows=%#v fields=%#v", rows, fields)
	}
	if !bytes.Contains(freshStdin.Bytes(), []byte(`"method":"query"`)) {
		t.Fatalf("fresh client did not receive query: %s", freshStdin.String())
	}
}

func TestMySQLAgentConnectRebuildsTransportAfterCancellation(t *testing.T) {
	previousRoot := currentExternalDriverDownloadDirectory()
	t.Cleanup(func() { SetExternalDriverDownloadDirectory(previousRoot) })
	root := t.TempDir()
	SetExternalDriverDownloadDirectory(root)
	driverDir := filepath.Join(root, "mysql")
	if err := os.MkdirAll(driverDir, 0o755); err != nil {
		t.Fatalf("create test driver directory: %v", err)
	}
	source, err := os.Executable()
	if err != nil {
		t.Fatalf("locate test executable: %v", err)
	}
	agentPath := filepath.Join(driverDir, optionalDriverAgentExecutableName("mysql"))
	payload, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read test executable: %v", err)
	}
	if err := os.WriteFile(agentPath, payload, 0o755); err != nil {
		t.Fatalf("write test agent executable: %v", err)
	}

	t.Setenv("GONAVI_MYSQL_AGENT_TEST_HELPER", "1")
	t.Setenv("GONAVI_MYSQL_AGENT_TEST_HELPER_HANG_QUERY", "1")
	dbInst := &MySQLAgentDB{}
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}
	if err := dbInst.Connect(config); err != nil {
		t.Fatalf("initial agent connect: %v", err)
	}
	t.Cleanup(func() { _ = dbInst.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	queryDone := make(chan error, 1)
	go func() {
		_, _, err := dbInst.QueryContext(ctx, "SELECT cancelled")
		queryDone <- err
	}()
	select {
	case err := <-queryDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("cancelled query error = %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("cancelled query remained blocked")
	}

	t.Setenv("GONAVI_MYSQL_AGENT_TEST_HELPER_HANG_QUERY", "")
	if err := dbInst.Connect(config); err != nil {
		t.Fatalf("reconnect after cancellation: %v", err)
	}
	rows, fields, err := dbInst.Query("SELECT recovered")
	if err != nil {
		t.Fatalf("query on rebuilt agent: %v", err)
	}
	if len(rows) != 1 || rows[0]["answer"] != int64(7) || len(fields) != 1 || fields[0] != "answer" {
		t.Fatalf("rebuilt agent response = rows=%#v fields=%#v", rows, fields)
	}
}

func TestMySQLAgentCloseDoesNotWaitForStuckCall(t *testing.T) {
	transport := newMySQLAgentBlockingTransport()
	defer transport.Close()
	client := &mysqlAgentClient{
		stdin:           transport,
		reader:          bufio.NewReader(transport),
		shutdownTimeout: 25 * time.Millisecond,
	}
	dbInst := &MySQLAgentDB{client: client}

	queryDone := make(chan error, 1)
	go func() {
		_, _, err := dbInst.Query("SELECT 1")
		queryDone <- err
	}()
	select {
	case <-transport.readStarted:
	case <-time.After(time.Second):
		t.Fatal("MySQL agent call did not start reading its response")
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- dbInst.Close() }()
	select {
	case err := <-queryDone:
		if err == nil {
			t.Fatal("expected the terminated in-flight query to return an error")
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Close did not terminate the in-flight MySQL agent call")
	}
	select {
	case <-closeDone:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Close remained blocked behind the in-flight MySQL agent lock")
	}
}

func TestMySQLAgentQueryWithoutContextKeepsLongRunningSemantics(t *testing.T) {
	var stdin mysqlAgentTestWriteCloser
	stdoutReader, stdoutWriter := io.Pipe()
	defer stdoutReader.Close()
	defer stdoutWriter.Close()
	client := &mysqlAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(stdoutReader),
	}
	dbInst := &MySQLAgentDB{client: client}

	type queryResult struct {
		rows   []map[string]interface{}
		fields []string
		err    error
	}
	result := make(chan queryResult, 1)
	go func() {
		rows, fields, err := dbInst.Query("SELECT slow_value")
		result <- queryResult{rows: rows, fields: fields, err: err}
	}()

	select {
	case early := <-result:
		t.Fatalf("query unexpectedly returned before delayed response: %v", early.err)
	case <-time.After(25 * time.Millisecond):
	}
	if _, err := stdoutWriter.Write([]byte(`{"id":1,"success":true,"data":[{"slow_value":42}],"fields":["slow_value"]}` + "\n")); err != nil {
		t.Fatalf("write delayed agent response: %v", err)
	}
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatalf("long-running query returned error: %v", got.err)
		}
		if len(got.rows) != 1 || got.rows[0]["slow_value"] != int64(42) {
			t.Fatalf("unexpected query rows: %#v", got.rows)
		}
		if len(got.fields) != 1 || got.fields[0] != "slow_value" {
			t.Fatalf("unexpected query fields: %#v", got.fields)
		}
	case <-time.After(time.Second):
		t.Fatal("query did not consume its delayed response")
	}
}

func TestMySQLAgentCancellationBeforeDispatchDoesNotStartOperation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var stdin mysqlAgentTestWriteCloser
	client := &mysqlAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true}` + "\n")),
	}
	dbInst := &MySQLAgentDB{client: client}

	_, _, err := dbInst.QueryContext(ctx, "SELECT 1")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled QueryContext returned %v, want context.Canceled", err)
	}
	if stdin.Len() != 0 {
		t.Fatalf("pre-cancelled QueryContext wrote %d bytes", stdin.Len())
	}
}

func TestMySQLAgentClientRejectsMismatchedResponseID(t *testing.T) {
	var stdin mysqlAgentTestWriteCloser
	client := &mysqlAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":99,"success":true}` + "\n")),
	}

	err := client.call(mysqlAgentRequest{Method: mysqlAgentMethodPing}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "响应 ID 不匹配") {
		t.Fatalf("mismatched response error = %v", err)
	}
	if err := client.call(mysqlAgentRequest{Method: mysqlAgentMethodPing}, nil, nil, nil); err == nil {
		t.Fatal("mismatched response left the transport reusable")
	}
}

type mysqlAgentCancelWhenDoneObservedContext struct {
	context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func (c *mysqlAgentCancelWhenDoneObservedContext) Done() <-chan struct{} {
	done := c.Context.Done()
	c.once.Do(c.cancel)
	return done
}

func TestMySQLAgentCancellationAfterGateAcquisitionDoesNotDispatch(t *testing.T) {
	for i := 0; i < 128; i++ {
		baseCtx, cancel := context.WithCancel(context.Background())
		ctx := &mysqlAgentCancelWhenDoneObservedContext{Context: baseCtx, cancel: cancel}
		var stdin mysqlAgentTestWriteCloser
		client := &mysqlAgentClient{
			stdin:  &stdin,
			reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true}` + "\n")),
		}
		operationStarted := false
		err := client.runWithContext(ctx, mysqlAgentMethodPing, func() error {
			operationStarted = true
			return nil
		})
		cancel()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("iteration %d returned %v, want context cancellation", i, err)
		}
		if operationStarted {
			t.Fatalf("iteration %d started an operation after cancellation", i)
		}
		if got := client.stoppedError(); got != nil {
			t.Fatalf("iteration %d terminated idle transport: %v", i, got)
		}
		if stdin.Len() != 0 {
			t.Fatalf("iteration %d wrote %d bytes after cancellation", i, stdin.Len())
		}
	}
}

func TestMySQLAgentUnresponsiveProcessIsReapedAfterTimeout(t *testing.T) {
	const helperMarker = "gonavi-mysql-agent-hang-helper"
	if os.Getenv("GONAVI_MYSQL_AGENT_HANG_HELPER") == "1" && len(os.Args) > 0 && os.Args[len(os.Args)-1] == helperMarker {
		time.Sleep(time.Hour)
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestMySQLAgentUnresponsiveProcessIsReapedAfterTimeout$", "--", helperMarker)
	cmd.Env = append(os.Environ(), "GONAVI_MYSQL_AGENT_HANG_HELPER=1")
	configureAgentProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("create helper stdin: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("create helper stdout: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper process: %v", err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})

	client := &mysqlAgentClient{
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		reader: bufio.NewReader(stdout),
	}
	err = client.callWithTimeout(mysqlAgentRequest{Method: mysqlAgentMethodPing}, nil, nil, nil, 50*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context deadline error, got %v", err)
	}
	if cmd.ProcessState == nil {
		t.Fatal("timed-out MySQL agent process was not reaped")
	}
}

func TestMySQLAgentResponseCompatibility(t *testing.T) {
	var stdin mysqlAgentTestWriteCloser
	client := &mysqlAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true,"data":[{"answer":42}],"fields":["answer"],"rowsAffected":3}` + "\n")),
	}
	var rows []map[string]interface{}
	var fields []string
	var affected int64
	if err := client.call(mysqlAgentRequest{Method: mysqlAgentMethodQuery}, &rows, &fields, &affected); err != nil {
		t.Fatalf("compatible response returned error: %v", err)
	}
	if len(rows) != 1 || rows[0]["answer"] != int64(42) || len(fields) != 1 || fields[0] != "answer" || affected != 3 {
		t.Fatalf("decoded response = rows=%#v fields=%#v affected=%d", rows, fields, affected)
	}
	var wire mysqlAgentRequest
	if err := json.Unmarshal(bytes.TrimSpace(stdin.Bytes()), &wire); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if wire.Method != mysqlAgentMethodQuery {
		t.Fatalf("request method = %q, want query", wire.Method)
	}
}
