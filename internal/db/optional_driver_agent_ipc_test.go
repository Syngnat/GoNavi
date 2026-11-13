package db

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	sshbridge "GoNavi-Wails/internal/ssh"
)

const formerOptionalDriverAgentJSONLineLimit = 32 << 20

func TestReadOptionalDriverAgentJSONLineReadsFormerOversizedFrame(t *testing.T) {
	oversized := append(bytes.Repeat([]byte{'x'}, formerOptionalDriverAgentJSONLineLimit), '\n')
	line, err := ReadOptionalDriverAgentJSONLine(bufio.NewReader(bytes.NewReader(oversized)))
	if err != nil || len(line) != len(oversized) {
		t.Fatalf("读取超大帧 = (%d, %v)，want (%d, nil)", len(line), err, len(oversized))
	}
}

func TestOptionalDriverAgentClientAcceptsResponseLargerThanFormerFrameLimit(t *testing.T) {
	data, err := json.Marshal(strings.Repeat("x", formerOptionalDriverAgentJSONLineLimit))
	if err != nil {
		t.Fatalf("构造超大响应数据失败：%v", err)
	}
	response, err := json.Marshal(optionalAgentResponse{ID: 1, Success: true, Data: data})
	if err != nil {
		t.Fatalf("构造超大响应失败：%v", err)
	}
	response = append(response, '\n')
	if len(response) <= formerOptionalDriverAgentJSONLineLimit {
		t.Fatalf("测试响应只有 %d 字节，未超过旧的 32 MiB 单帧上限", len(response))
	}
	stdout := append(append([]byte(nil), response...), []byte(`{"id":2,"success":true}`+"\n")...)

	var stdin optionalAgentTestWriteCloser
	var out string
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(stdout)),
		driver: "duckdb",
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodQuery}, &out, nil, nil, nil); err != nil {
		t.Fatalf("超大响应失败：%v", err)
	}
	if len(out) != formerOptionalDriverAgentJSONLineLimit {
		t.Fatalf("超大响应长度 = %d，want %d", len(out), formerOptionalDriverAgentJSONLineLimit)
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil); err != nil {
		t.Fatalf("超大响应后传输应可继续使用：%v", err)
	}
}

func TestOptionalDriverAgentClientSendsRequestLargerThanFormerFrameLimit(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true}` + "\n")),
		driver: "duckdb",
	}

	err := client.call(optionalAgentRequest{
		Method:    optionalAgentMethodQuery,
		SessionID: strings.Repeat("x", formerOptionalDriverAgentJSONLineLimit),
	}, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("超大请求失败：%v", err)
	}
	if stdin.Len() <= formerOptionalDriverAgentJSONLineLimit {
		t.Fatalf("超大请求写入 %d 字节，未超过旧的 32 MiB 单帧上限", stdin.Len())
	}
}

func TestOptionalDriverAgentClientRehydratesUnknownApplyChangesOutcome(t *testing.T) {
	response, err := json.Marshal(optionalAgentResponse{
		ID:             1,
		Success:        false,
		Error:          "response lost",
		OutcomeUnknown: true,
	})
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(response, '\n'))),
		driver: "mongodb",
	}
	err = client.call(optionalAgentRequest{Method: optionalAgentMethodApplyChanges}, nil, nil, nil, nil)
	if !IsWriteOutcomeUnknown(err) || err.Error() != "response lost" {
		t.Fatalf("applyChanges error = %T %v, unknown=%t", err, err, IsWriteOutcomeUnknown(err))
	}
}

func TestOptionalDriverAgentClientRejectsOutcomeUnknownOnInvalidResponse(t *testing.T) {
	tests := []struct {
		name    string
		method  string
		success bool
	}{
		{name: "successful applyChanges", method: optionalAgentMethodApplyChanges, success: true},
		{name: "non-applyChanges failure", method: optionalAgentMethodQuery, success: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, err := json.Marshal(optionalAgentResponse{ID: 1, Success: test.success, Error: "bad marker", OutcomeUnknown: true})
			if err != nil {
				t.Fatalf("marshal response: %v", err)
			}
			var stdin optionalAgentTestWriteCloser
			client := &optionalDriverAgentClient{
				stdin:  &stdin,
				reader: bufio.NewReader(bytes.NewReader(append(response, '\n'))),
				driver: "mongodb",
			}
			err = client.call(optionalAgentRequest{Method: test.method}, nil, nil, nil, nil)
			if err == nil || !strings.Contains(err.Error(), "outcomeUnknown") {
				t.Fatalf("protocol error = %v", err)
			}
		})
	}
}

func TestOptionalDriverAgentClientAcceptsStreamChunkLargerThanFormerFrameLimit(t *testing.T) {
	row, err := json.Marshal([][]string{{strings.Repeat("x", formerOptionalDriverAgentJSONLineLimit)}})
	if err != nil {
		t.Fatalf("构造超大流式行失败：%v", err)
	}
	frames := []string{
		`{"id":1,"success":true,"chunkType":"columns","fields":["payload"]}`,
		`{"id":1,"success":true,"chunkType":"rows","data":` + string(row) + `}`,
		`{"id":1,"success":true,"chunkType":"done"}`,
		`{"id":2,"success":true}`,
	}
	stdout := strings.Join(frames, "\n") + "\n"
	rowsFrame := frames[1] + "\n"
	if len(rowsFrame) <= formerOptionalDriverAgentJSONLineLimit {
		t.Fatalf("流式行帧只有 %d 字节，未超过旧的 32 MiB 单帧上限", len(rowsFrame))
	}

	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(stdout)),
		driver: "duckdb",
	}
	consumer := &optionalAgentTestStreamConsumer{}
	if err := client.callStreamQuery(optionalAgentRequest{Method: optionalAgentMethodStreamQuery}, consumer); err != nil {
		t.Fatalf("超大流式响应失败：%v", err)
	}
	if len(consumer.rows) != 1 || consumer.rows[0][0] != strings.Repeat("x", formerOptionalDriverAgentJSONLineLimit) {
		t.Fatalf("超大流式行未完整读回：rows=%d", len(consumer.rows))
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil); err != nil {
		t.Fatalf("超大流式响应后传输应可继续使用：%v", err)
	}
}

func TestOptionalDriverAgentClientAcceptsLargeResponseWithinLimit(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	data, err := json.Marshal(strings.Repeat("x", 4<<20))
	if err != nil {
		t.Fatalf("构造大响应失败：%v", err)
	}
	response, err := json.Marshal(optionalAgentResponse{ID: 1, Success: true, Data: data})
	if err != nil {
		t.Fatalf("构造响应失败：%v", err)
	}
	response = append(response, '\n')

	var out string
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(response)),
		driver: "duckdb",
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodQuery}, &out, nil, nil, nil); err != nil {
		t.Fatalf("上限内大响应失败：%v", err)
	}
	if len(out) != 4<<20 {
		t.Fatalf("上限内大响应长度 = %d，want %d", len(out), 4<<20)
	}
}

func TestOptionalAgentConnectRequestCarriesSSHRuntimeSeparately(t *testing.T) {
	config := connection.ConnectionConfig{
		Type:   "kingbase",
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "127.0.0.1",
			Port: 37167,
		}.WithManagedHostKeyTrustStore("/private/gonavi/ssh/host_keys.json").
			WithHostKeyIdentity("bastion.example.test", 37167),
	}

	request := newOptionalAgentConnectRequest(config)
	if request.SSHRuntime == nil {
		t.Fatal("connect request omitted SSH runtime snapshot")
	}
	if !request.StreamSSHProgress {
		t.Fatal("SSH connect request did not subscribe to SSH progress frames")
	}
	if request.SSHRuntime.ManagedHostKeyTrustStorePath != "/private/gonavi/ssh/host_keys.json" {
		t.Fatalf("request managed trust-store path = %q", request.SSHRuntime.ManagedHostKeyTrustStorePath)
	}
	if request.SSHRuntime.HostKeyIdentityHost != "bastion.example.test" || request.SSHRuntime.HostKeyIdentityPort != 37167 {
		t.Fatalf("request logical host-key identity = %#v", request.SSHRuntime)
	}

	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal connect request: %v", err)
	}
	var decoded optionalAgentRequest
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal connect request: %v", err)
	}
	if decoded.Config == nil {
		t.Fatal("decoded connect request omitted config")
	}
	if got := decoded.Config.SSH.ManagedHostKeyTrustStorePath(); got != "" {
		t.Fatalf("SSH runtime leaked into serialized connection config: %q", got)
	}
	if decoded.SSHRuntime == nil || decoded.SSHRuntime.ManagedHostKeyTrustStorePath != "/private/gonavi/ssh/host_keys.json" {
		t.Fatalf("decoded request lost SSH runtime snapshot: %#v", decoded.SSHRuntime)
	}
}

func TestOptionalDriverAgentClientRehydratesSSHHostKeyTrustError(t *testing.T) {
	status := sshbridge.HostKeyTrustStatus{
		State:       "unknown",
		Source:      "discovered",
		Host:        "bastion.example.test",
		Port:        37167,
		Address:     "bastion.example.test:37167",
		KeyType:     "ssh-ed25519",
		Fingerprint: "SHA256:server-key",
	}
	wire, err := json.Marshal(optionalAgentResponse{
		ID:              1,
		Success:         false,
		Error:           "创建 SSH 隧道失败：knownhosts: key is unknown",
		SSHHostKeyTrust: &status,
	})
	if err != nil {
		t.Fatalf("marshal agent response: %v", err)
	}

	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(wire, '\n'))),
		driver: "kingbase",
	}
	err = client.call(optionalAgentRequest{Method: optionalAgentMethodConnect}, nil, nil, nil, nil)
	var trustErr *sshbridge.HostKeyTrustRequiredError
	if !errors.As(err, &trustErr) {
		t.Fatalf("expected unwrapable SSH host-key trust error, got %T: %v", err, err)
	}
	if trustErr.Status != status {
		t.Fatalf("rehydrated trust status = %#v, want %#v", trustErr.Status, status)
	}
}

func TestOptionalDriverAgentClientForwardsSSHProgressFramesBeforeFinalConnectResponse(t *testing.T) {
	progress := []connection.SSHProgressEvent{
		{Stage: "tcp_connecting", Status: "running"},
		{Stage: "tcp_connected", Status: "success"},
		{Stage: "host_key_verified", Status: "success"},
		{Stage: "tunnel_ready", Status: "success"},
	}
	frames := make([][]byte, 0, len(progress)+1)
	for _, event := range progress {
		event := event
		frame, err := json.Marshal(optionalAgentResponse{
			ID:          1,
			Success:     true,
			SSHProgress: &event,
		})
		if err != nil {
			t.Fatalf("marshal SSH progress frame: %v", err)
		}
		frames = append(frames, frame)
	}
	finalFrame, err := json.Marshal(optionalAgentResponse{
		ID:      1,
		Success: true,
		Data:    json.RawMessage(`{"elasticsearchServerMajor":8}`),
	})
	if err != nil {
		t.Fatalf("marshal final connect response: %v", err)
	}
	frames = append(frames, finalFrame)

	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(bytes.Join(frames, []byte{'\n'}), '\n'))),
		driver: "kingbase",
	}
	gotProgress := make([]connection.SSHProgressEvent, 0, len(progress))
	var info optionalAgentConnectionInfo
	err = client.call(optionalAgentRequest{
		Method:            optionalAgentMethodConnect,
		StreamSSHProgress: true,
		sshProgressReporter: func(event connection.SSHProgressEvent) {
			gotProgress = append(gotProgress, event)
		},
	}, &info, nil, nil, nil)
	if err != nil {
		t.Fatalf("connect call: %v", err)
	}
	if len(gotProgress) != len(progress) {
		t.Fatalf("SSH progress events = %#v, want %#v", gotProgress, progress)
	}
	for index, want := range progress {
		if gotProgress[index] != want {
			t.Fatalf("SSH progress event %d = %#v, want %#v", index, gotProgress[index], want)
		}
	}
	if info.ElasticsearchServerMajor != 8 {
		t.Fatalf("final connect response was not consumed: %#v", info)
	}
}

func TestOptionalDriverAgentClientRejectsUnexpectedSSHProgressFrameAndStopsTransport(t *testing.T) {
	progressFrame, err := json.Marshal(optionalAgentResponse{
		ID:          1,
		Success:     true,
		SSHProgress: &connection.SSHProgressEvent{Stage: "tcp_connected", Status: "success"},
	})
	if err != nil {
		t.Fatalf("marshal unexpected progress frame: %v", err)
	}

	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(progressFrame, '\n'))),
		driver: "kingbase",
	}
	err = client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "SSH 进度帧") {
		t.Fatalf("unexpected progress frame error = %v", err)
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil); !errors.Is(err, errOptionalAgentTransportStopped) {
		t.Fatalf("unexpected progress frame did not stop transport: %v", err)
	}
	if writes := bytes.Count(stdin.Bytes(), []byte{'\n'}); writes != 1 {
		t.Fatalf("unexpected progress frame writes = %d, want 1", writes)
	}
}

func TestOptionalDriverAgentClientRejectsMismatchedSSHProgressFrameAndStopsTransport(t *testing.T) {
	progressFrame, err := json.Marshal(optionalAgentResponse{
		ID:          2,
		Success:     true,
		SSHProgress: &connection.SSHProgressEvent{Stage: "tcp_connected", Status: "success"},
	})
	if err != nil {
		t.Fatalf("marshal mismatched progress frame: %v", err)
	}

	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(progressFrame, '\n'))),
		driver: "kingbase",
	}
	reported := false
	err = client.call(optionalAgentRequest{
		Method:            optionalAgentMethodConnect,
		StreamSSHProgress: true,
		sshProgressReporter: func(connection.SSHProgressEvent) {
			reported = true
		},
	}, nil, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "响应 ID 不匹配") {
		t.Fatalf("mismatched progress frame error = %v", err)
	}
	if reported {
		t.Fatal("mismatched progress frame was reported to the caller")
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil); !errors.Is(err, errOptionalAgentTransportStopped) {
		t.Fatalf("mismatched progress frame did not stop transport: %v", err)
	}
}

func TestOptionalDriverAgentClientForwardsSSHProgressBeforeFinalConnectError(t *testing.T) {
	progressFrame, err := json.Marshal(optionalAgentResponse{
		ID:          1,
		Success:     true,
		SSHProgress: &connection.SSHProgressEvent{Stage: "host_key_verifying", Status: "error"},
	})
	if err != nil {
		t.Fatalf("marshal progress frame: %v", err)
	}
	finalFrame, err := json.Marshal(optionalAgentResponse{
		ID:      1,
		Success: false,
		Error:   "knownhosts: key is unknown",
	})
	if err != nil {
		t.Fatalf("marshal final error frame: %v", err)
	}

	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(bytes.Join([][]byte{progressFrame, finalFrame}, []byte{'\n'}), '\n'))),
		driver: "kingbase",
	}
	var reported []connection.SSHProgressEvent
	err = client.call(optionalAgentRequest{
		Method:            optionalAgentMethodConnect,
		StreamSSHProgress: true,
		sshProgressReporter: func(event connection.SSHProgressEvent) {
			reported = append(reported, event)
		},
	}, nil, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "knownhosts: key is unknown") {
		t.Fatalf("final connect error = %v", err)
	}
	if want := []connection.SSHProgressEvent{{Stage: "host_key_verifying", Status: "error"}}; !reflect.DeepEqual(reported, want) {
		t.Fatalf("reported progress = %#v, want %#v", reported, want)
	}
}

func TestOptionalDriverAgentClientDecodesPartialDataAlongsideError(t *testing.T) {
	response, err := json.Marshal(optionalAgentResponse{
		ID:          1,
		Success:     false,
		Error:       "admin topic listing denied",
		Data:        json.RawMessage(`["persistent://public/default/orders"]`),
		PartialData: true,
	})
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(response, '\n'))),
		driver: "pulsar",
	}
	var tables []string
	err = client.call(optionalAgentRequest{Method: optionalAgentMethodGetTables, DBName: "topics"}, &tables, nil, nil, nil)
	if err == nil || err.Error() != "admin topic listing denied" {
		t.Fatalf("partial response must still return the driver error, got %v", err)
	}
	if len(tables) != 1 || tables[0] != "persistent://public/default/orders" {
		t.Fatalf("partial response lost the known topics: %#v", tables)
	}
}

func TestOptionalDriverAgentClientIgnoresDataOnPlainFailure(t *testing.T) {
	response, err := json.Marshal(optionalAgentResponse{
		ID:      1,
		Success: false,
		Error:   "boom",
		Data:    json.RawMessage(`["stale"]`),
	})
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(append(response, '\n'))),
		driver: "pulsar",
	}
	var tables []string
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodGetTables}, &tables, nil, nil, nil); err == nil {
		t.Fatal("failure must return an error")
	}
	if tables != nil {
		t.Fatalf("failure without PartialData must not decode data: %#v", tables)
	}
}
