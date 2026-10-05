package main

import (
	"fmt"
	"os"
	"runtime/debug"
)

// recoverAgentRequestPanic 把单个业务请求里第三方驱动的 panic 转成该请求的错误响应，
// 避免整个代理进程退出（主进程会把进程退出当成驱动不可用）。必须直接作为 defer 调用。
func recoverAgentRequestPanic(req agentRequest, writer *agentResponseWriter) {
	recovered := recover()
	if recovered == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "驱动代理处理 %s 请求时发生 panic：%v\n%s\n", req.Method, recovered, debug.Stack())
	_ = writer.write(agentResponse{
		ID:      req.ID,
		Success: false,
		Error:   fmt.Sprintf("driver panic during %s: %v", req.Method, recovered),
	})
}
