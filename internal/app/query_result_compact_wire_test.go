package app

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestCompactQueryResultWireForm 锁定 CompactQueryResult 的 JSON 线格式。
//
// 背景：前端 queryResultTransport.ts 的 decodeCompactResultData 要求
//
//	typeof result.encodedData === 'string'
//
// 才走 base64+gzip 解码；而 Wails 生成的 frontend/wailsjs/go/models.ts 把
// []byte 映射成 `number[]`（TS 生成器行为）。二者若不一致，压缩载荷会被
// 前端静默跳过 —— 该路径此前没有生产调用点，从未被实机验证。
//
// 本测试以 Go 侧 JSON 编码结果为准：encoding/json 对 []byte 输出 base64 **字符串**，
// 故运行时类型是 string，前端判定成立。若将来有人把 EncodedData 改成别的类型，
// 这个测试会失败，提示前端解码侧需要同步调整。
func TestCompactQueryResultWireForm(t *testing.T) {
	payload := []byte{0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef}
	affectedRows := int64(0)

	raw, err := json.Marshal(CompactQueryResult{
		QueryResult: connection.QueryResult{
			Success: true,
			Message: "ok",
			StatementResults: []connection.StatementExecutionResult{{
				StatementIndex: 1,
				Status:         connection.StatementResultSuccess,
				AffectedRows:   &affectedRows,
			}},
		},
		DataEncoding: compactQueryResultEncoding,
		EncodedData:  payload,
	})
	if err != nil {
		t.Fatalf("marshal CompactQueryResult: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal 回读: %v", err)
	}

	// 1) encodedData 在线格式上必须是字符串（base64），而不是数字数组。
	encoded, ok := decoded["encodedData"]
	if !ok {
		t.Fatalf("encodedData 未出现在 JSON 中，原始输出：%s", raw)
	}
	if _, isString := encoded.(string); !isString {
		t.Fatalf("encodedData 运行时类型应为 string（base64），实际为 %T；原始输出：%s", encoded, raw)
	}

	// 2) 编码标识必须与前端常量一致，否则前端不会进入解码分支。
	if got, want := decoded["dataEncoding"], compactQueryResultEncoding; got != want {
		t.Fatalf("dataEncoding = %v，期望 %v", got, want)
	}
	statementResults, ok := decoded["statementResults"].([]interface{})
	if !ok || len(statementResults) != 1 {
		t.Fatalf("statementResults 未保留在 JSON 线格式中：%#v", decoded["statementResults"])
	}
	statementResult, ok := statementResults[0].(map[string]interface{})
	if !ok || statementResult["status"] != connection.StatementResultSuccess || statementResult["affectedRows"] != float64(0) {
		t.Fatalf("statementResult 字段不完整：%#v", statementResults[0])
	}
	if !strings.Contains(compactQueryResultEncoding, "base64") {
		t.Fatalf("dataEncoding(%q) 未声明 base64，前端 decodeBase64 会解错", compactQueryResultEncoding)
	}

	// 3) 回读内容应与原始字节一致（base64 往返无损）。
	decodedBytes, err := base64.StdEncoding.DecodeString(encoded.(string))
	if err != nil {
		t.Fatalf("base64 解码失败：%v", err)
	}
	if string(decodedBytes) != string(payload) {
		t.Fatalf("base64 往返内容不一致：got %v want %v", decodedBytes, payload)
	}
}
