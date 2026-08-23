package db

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestReadOptionalDriverAgentJSONLineEnforcesFrameLimit(t *testing.T) {
	valid := bytes.Repeat([]byte{'x'}, OptionalDriverAgentMaxJSONLineBytes-1)
	line, err := ReadOptionalDriverAgentJSONLine(bufio.NewReader(bytes.NewReader(append(valid, '\n'))))
	if err != nil || len(line) != OptionalDriverAgentMaxJSONLineBytes {
		t.Fatalf("读取上限内帧 = (%d, %v)，want (%d, nil)", len(line), err, OptionalDriverAgentMaxJSONLineBytes)
	}

	oversized := append(bytes.Repeat([]byte{'x'}, OptionalDriverAgentMaxJSONLineBytes), '\n')
	line, err = ReadOptionalDriverAgentJSONLine(bufio.NewReader(bytes.NewReader(oversized)))
	if !errors.Is(err, ErrOptionalDriverAgentJSONLineTooLarge) || line != nil {
		t.Fatalf("超限帧 = (%d, %v)，want (0, ErrOptionalDriverAgentJSONLineTooLarge)", len(line), err)
	}
}

func TestOptionalDriverAgentClientRejectsOversizedResponseAndDoesNotReuseTransport(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	oversized := append(bytes.Repeat([]byte{'x'}, OptionalDriverAgentMaxJSONLineBytes), '\n')
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(oversized)),
		driver: "duckdb",
	}

	err := client.call(optionalAgentRequest{Method: optionalAgentMethodQuery}, nil, nil, nil, nil)
	if !errors.Is(err, ErrOptionalDriverAgentJSONLineTooLarge) {
		t.Fatalf("超限普通响应错误 = %v，want ErrOptionalDriverAgentJSONLineTooLarge", err)
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil); !errors.Is(err, errOptionalAgentTransportStopped) {
		t.Fatalf("超限后复用传输错误 = %v，want stopped", err)
	}
	if writes := bytes.Count(stdin.Bytes(), []byte{'\n'}); writes != 1 {
		t.Fatalf("超限后写入次数 = %d，want 1", writes)
	}
}

func TestOptionalDriverAgentClientRejectsOversizedRequest(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true}` + "\n")),
		driver: "duckdb",
	}

	err := client.call(optionalAgentRequest{
		Method:    optionalAgentMethodQuery,
		SessionID: strings.Repeat("x", OptionalDriverAgentMaxJSONLineBytes),
	}, nil, nil, nil, nil)
	if !errors.Is(err, ErrOptionalDriverAgentJSONLineTooLarge) {
		t.Fatalf("超限请求错误 = %v，want ErrOptionalDriverAgentJSONLineTooLarge", err)
	}
	if stdin.Len() != 0 {
		t.Fatalf("超限请求仍写入 %d 字节，want 0", stdin.Len())
	}
}

func TestOptionalDriverAgentClientRejectsOversizedStreamChunkAndDoesNotReuseTransport(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	oversized := append(bytes.Repeat([]byte{'x'}, OptionalDriverAgentMaxJSONLineBytes), '\n')
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(oversized)),
		driver: "duckdb",
	}

	err := client.callStreamQuery(optionalAgentRequest{Method: optionalAgentMethodStreamQuery}, &optionalAgentTestStreamConsumer{})
	if !errors.Is(err, ErrOptionalDriverAgentJSONLineTooLarge) {
		t.Fatalf("超限流式响应错误 = %v，want ErrOptionalDriverAgentJSONLineTooLarge", err)
	}
	if err := client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil); !errors.Is(err, errOptionalAgentTransportStopped) {
		t.Fatalf("流式超限后复用传输错误 = %v，want stopped", err)
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
	if len(response) >= OptionalDriverAgentMaxJSONLineBytes {
		t.Fatalf("测试响应 %d 字节，意外超过上限", len(response))
	}

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
