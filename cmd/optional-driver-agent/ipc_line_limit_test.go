package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/db"
)

// decodeAgentResponses 把 JSON-lines 输出解析为响应列表。
func decodeAgentResponses(t *testing.T, payload []byte) []agentResponse {
	t.Helper()
	var out []agentResponse
	for _, line := range strings.Split(strings.TrimSpace(string(payload)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var resp agentResponse
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			t.Fatalf("解析响应失败：%v\n原始行前 200 字节：%.200s", err, line)
		}
		out = append(out, resp)
	}
	return out
}

// TestServeAgentRequestsHandlesLinesLargerThanLegacyScannerLimit 覆盖超大请求行。
//
// 回归背景：agent 原先用 bufio.Scanner 且单行上限硬编码 8 MiB，而主进程把整个请求
// （含 1000 行导入批次的 ChangeSet）序列化成一行且无任何上限。超限时 Scanner 报
// token too long、Scan() 返回 false，主循环退出、进程终止，该连接从此永久不可用：
// 主进程后续所有查询/元数据操作都返回「读取驱动代理响应失败：EOF」，只能手动重连。
func TestServeAgentRequestsHandlesLinesLargerThanLegacyScannerLimit(t *testing.T) {
	const legacyScannerLimit = 8 << 20

	// 构造一个远超旧上限的合法请求：用一个超大字符串参数把单行撑到 ~12 MiB。
	huge := strings.Repeat("x", 12<<20)
	payload, err := json.Marshal(agentRequest{ID: 1, Method: agentMethodMetadata, SessionID: huge})
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	if len(payload) <= legacyScannerLimit {
		t.Fatalf("测试请求只有 %d 字节，未超过旧的 %d 字节上限，无法覆盖该回归", len(payload), legacyScannerLimit)
	}

	// 超大行之后再跟一个正常请求：若主循环因超限退出，第二个请求就不会被处理。
	followUp, err := json.Marshal(agentRequest{ID: 2, Method: agentMethodMetadata})
	if err != nil {
		t.Fatalf("构造后续请求失败：%v", err)
	}

	input := bytes.NewReader(append(append(payload, '\n'), append(followUp, '\n')...))
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	runtimeState := &agentRuntime{sessions: make(map[string]db.StatementExecer)}

	if err := serveAgentRequests(input, writer, runtimeState); err != nil {
		t.Fatalf("serveAgentRequests 返回错误：%v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("Flush 失败：%v", err)
	}

	responses := decodeAgentResponses(t, out.Bytes())
	if len(responses) != 2 {
		t.Fatalf("响应条数 = %d，期望 2（超大行后主循环提前退出，连接被打死）", len(responses))
	}
	if responses[0].ID != 1 {
		t.Errorf("第一条响应 ID = %d，期望 1", responses[0].ID)
	}
	if responses[1].ID != 2 {
		t.Errorf("第二条响应 ID = %d，期望 2（后续请求未被处理说明循环已退出）", responses[1].ID)
	}
}

// TestServeAgentRequestsReportsInvalidJSONWithoutExiting 非法 JSON 只回错误响应，不得终止循环。
func TestServeAgentRequestsReportsInvalidJSONWithoutExiting(t *testing.T) {
	followUp, err := json.Marshal(agentRequest{ID: 9, Method: agentMethodMetadata})
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}

	input := strings.NewReader("{not json}\n\n" + string(followUp) + "\n")
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	runtimeState := &agentRuntime{sessions: make(map[string]db.StatementExecer)}

	if err := serveAgentRequests(input, writer, runtimeState); err != nil {
		t.Fatalf("serveAgentRequests 返回错误：%v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("Flush 失败：%v", err)
	}

	responses := decodeAgentResponses(t, out.Bytes())
	if len(responses) != 2 {
		t.Fatalf("响应条数 = %d，期望 2（解析失败一条 + 后续正常一条）", len(responses))
	}
	if responses[0].Success {
		t.Error("非法 JSON 的响应不应是 Success")
	}
	if responses[1].ID != 9 || !responses[1].Success {
		t.Errorf("后续正常请求未被处理：%#v", responses[1])
	}
}

// TestServeAgentRequestsHandlesFinalLineWithoutNewline 末行无换行符时仍须处理。
func TestServeAgentRequestsHandlesFinalLineWithoutNewline(t *testing.T) {
	payload, err := json.Marshal(agentRequest{ID: 5, Method: agentMethodMetadata})
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}

	input := bytes.NewReader(payload) // 故意不加末尾换行
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	runtimeState := &agentRuntime{sessions: make(map[string]db.StatementExecer)}

	if err := serveAgentRequests(input, writer, runtimeState); err != nil {
		t.Fatalf("serveAgentRequests 返回错误：%v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("Flush 失败：%v", err)
	}

	responses := decodeAgentResponses(t, out.Bytes())
	if len(responses) != 1 || responses[0].ID != 5 {
		t.Fatalf("末行无换行符的请求未被处理：%#v", responses)
	}
}
