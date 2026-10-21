package db

import (
	"bufio"
	"errors"
	"strings"
	"testing"
)

// TestOptionalDriverAgentClientStreamKeepsTransportAfterOversizedChunkFailure 覆盖
// 「agent 主动就单帧超限写出失败帧」这一分支。
//
// 回归背景：超大单行让 agent 放弃发送该批数据并以失败帧收尾时，主进程此前会顺手
// forceTerminate 整个 transport，把「一次查询失败」升级成「连接永久不可用」——用户侧
// 表现为预览一条超大消息后，该连接的所有操作都报「驱动代理传输不可用」。agent 已经就该
// 请求写出终止帧，帧边界仍然可信，transport 必须继续可用。
func TestOptionalDriverAgentClientStreamKeepsTransportAfterOversizedChunkFailure(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	oversizedFailureFrame := `{"id":1,"success":false,"error":"` + ErrOptionalDriverAgentJSONLineTooLarge.Error() + `"}`
	stdout := strings.Join([]string{
		streamTestRequestFrames(1, `[[1,"alice"]]`)[0],
		oversizedFailureFrame,
		streamTestRequestFrames(2, `[[2,"bob"]]`)[0],
		streamTestRequestFrames(2, `[[2,"bob"]]`)[1],
		streamTestDoneFrame(2),
	}, "\n") + "\n"

	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(stdout)),
		driver: "kafka",
	}
	err := client.callStreamQuery(optionalAgentRequest{
		Method: optionalAgentMethodStreamQuery,
		Query:  "SELECT * FROM oversized_topic",
	}, &optionalAgentTestStreamConsumer{})
	if !errors.Is(err, ErrOptionalDriverAgentJSONLineTooLarge) {
		t.Fatalf("超限失败帧错误 = %v，want ErrOptionalDriverAgentJSONLineTooLarge", err)
	}
	if stoppedErr := client.stoppedError(); stoppedErr != nil {
		t.Fatalf("单帧超限后 transport 不应被终止：%v", stoppedErr)
	}

	next := &optionalAgentTestStreamConsumer{}
	if nextErr := client.callStreamQuery(optionalAgentRequest{
		Method: optionalAgentMethodStreamQuery,
		Query:  "SELECT 2",
	}, next); nextErr != nil {
		t.Fatalf("超限失败帧后下一个请求应正常完成: %v", nextErr)
	}
	if len(next.rows) != 1 || next.rows[0][0] != int64(2) {
		t.Fatalf("下一个请求读到异常数据: %#v", next.rows)
	}
}
