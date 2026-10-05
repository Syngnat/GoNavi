package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"GoNavi-Wails/internal/db"
)

// 本文件承载 driver-agent 的请求分发：读取循环与业务执行分离。
//
// 背景：原实现把「读一帧」和「执行该帧」放在同一个 goroutine 里，执行查询期间读取
// 循环被阻塞，agent 无法读到主进程随后发来的取消通知——这正是「停止只能杀进程」的
// 结构性原因。现在读取循环只负责收帧，业务请求交给单 worker 串行执行，取消通知在
// 读取循环内即刻处理，因此查询执行期间也能被中止。

// serveAgentRequests 是 driver-agent 的 JSON-lines 请求主循环。
//
// 使用带协议上限的 Reader，而不是 Scanner 或 ReadString：前者的固定上限会把可恢复的
// 大请求误判为错误，后者则会为缺少换行的输入无限增长。超限时终止当前代理，由主进程
// 重建传输，避免残留半帧污染后续请求。
//
// 返回非 nil 表示读取过程出现了非 EOF 的真实错误。
func serveAgentRequests(input io.Reader, writer *bufio.Writer, runtimeState *agentRuntime) error {
	reader := bufio.NewReaderSize(input, 16<<10)
	responseWriter := newAgentResponseWriter(writer)

	// 业务请求交给单个 worker 串行执行：既保持原先「一次一条、响应按请求顺序返回」的
	// 语义，又让读取循环在执行查询期间继续收帧，从而读到取消通知。
	business := newAgentBusinessQueue()
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		business.run(func(req agentRequest) {
			dispatchBusinessRequest(runtimeState, req, responseWriter)
		})
	}()
	// 退出前排空队列，避免 runtimeState 在仍有请求执行时被关闭。
	defer func() {
		business.close()
		<-workerDone
	}()

	for {
		raw, err := db.ReadOptionalDriverAgentJSONLine(reader)
		if err != nil && len(raw) == 0 {
			if errors.Is(err, io.EOF) {
				return nil
			}
			if errors.Is(err, db.ErrOptionalDriverAgentJSONLineTooLarge) {
				_ = responseWriter.write(agentResponse{
					Success: false,
					Error:   db.ErrOptionalDriverAgentJSONLineTooLarge.Error(),
				})
			}
			return err
		}
		// err != nil 但 raw 非空：最后一行没有换行符，仍需处理；
		// 下一轮读取会立即以 len(raw)==0 返回并结束循环。
		line := strings.TrimSpace(string(raw))
		if line == "" {
			continue
		}

		var req agentRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = responseWriter.write(agentResponse{
				ID:      req.ID,
				Success: false,
				Error:   fmt.Sprintf("解析请求失败：%v", err),
			})
			continue
		}

		// 取消通知不走业务队列：它是唯一在查询执行期间到达的请求，必须就地处理，
		// 并且按约定不回帧（效果由被取消请求自己的响应体现）。
		if strings.TrimSpace(req.Method) == agentMethodCancelQuery {
			handleCancelRequest(runtimeState, req)
			continue
		}

		business.push(req)
	}
}

// agentBusinessQueue 承接读取循环收到的业务请求，由单 worker 串行消费。
//
// 入队不阻塞：读取循环任何时刻都能继续收帧，这是查询执行期间仍能读到取消通知的前提
// （若在投递处阻塞，第二条业务请求就会把读取循环卡住，取消通知将延迟到宽限期之后）。
type agentBusinessQueue struct {
	mu      sync.Mutex
	cond    *sync.Cond
	pending []agentRequest
	closed  bool
}

func newAgentBusinessQueue() *agentBusinessQueue {
	queue := &agentBusinessQueue{}
	queue.cond = sync.NewCond(&queue.mu)
	return queue
}

func (q *agentBusinessQueue) push(req agentRequest) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.pending = append(q.pending, req)
	q.cond.Signal()
}

func (q *agentBusinessQueue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.closed = true
	q.cond.Broadcast()
}

// run 串行消费队列，直到队列关闭且已排空。
func (q *agentBusinessQueue) run(handle func(agentRequest)) {
	for {
		q.mu.Lock()
		for len(q.pending) == 0 && !q.closed {
			q.cond.Wait()
		}
		if len(q.pending) == 0 {
			q.mu.Unlock()
			return
		}
		req := q.pending[0]
		q.pending = q.pending[1:]
		q.mu.Unlock()

		handle(req)
	}
}

// dispatchBusinessRequest 串行执行一条业务请求，并登记它作为取消通知的目标。
func dispatchBusinessRequest(runtimeState *agentRuntime, req agentRequest, writer *agentResponseWriter) {
	defer recoverAgentRequestPanic(req, writer)
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	defer cancelRequest()
	generation := runtimeState.canceller.register(req.ID, cancelRequest)
	defer runtimeState.canceller.unregister(req.ID, generation)

	method := strings.TrimSpace(req.Method)
	if method == agentMethodStreamQuery {
		if err := handleStreamRequest(requestCtx, runtimeState, req, writer); err != nil {
			fmt.Fprintf(os.Stderr, "写入流式响应失败：%v\n", err)
			if errors.Is(err, db.ErrOptionalDriverAgentJSONLineTooLarge) {
				_ = writer.write(agentResponse{
					ID:      req.ID,
					Success: false,
					Error:   db.ErrOptionalDriverAgentJSONLineTooLarge.Error(),
				})
			}
		}
		return
	}
	if method == agentMethodConnect && req.StreamSSHProgress {
		if err := handleConnectRequest(requestCtx, runtimeState, req, writer); err != nil {
			fmt.Fprintf(os.Stderr, "写入 SSH 连接进度失败：%v\n", err)
			if errors.Is(err, db.ErrOptionalDriverAgentJSONLineTooLarge) {
				_ = writer.write(agentResponse{
					ID:      req.ID,
					Success: false,
					Error:   db.ErrOptionalDriverAgentJSONLineTooLarge.Error(),
				})
			}
		}
		return
	}

	resp := handleRequestWithContext(requestCtx, runtimeState, req, nil)
	if err := writer.write(resp); err != nil {
		fmt.Fprintf(os.Stderr, "写入响应失败：%v\n", err)
		if errors.Is(err, db.ErrOptionalDriverAgentJSONLineTooLarge) {
			_ = writer.write(agentResponse{
				ID:      req.ID,
				Success: false,
				Error:   db.ErrOptionalDriverAgentJSONLineTooLarge.Error(),
			})
		}
		return
	}
	if method == agentMethodQuery {
		maybeReleaseAgentMemory("query-response", countAgentResponseRows(resp.Data))
	}
}

// handleCancelRequest 处理取消通知：中止指定在途请求，不回帧。
//
// 取消通知没有响应帧（见 agentMethodCancelQuery 的约定），主进程通过被取消请求自己的
// 响应观察结果，因此帧内 ID 只用于定位目标与日志。
func handleCancelRequest(runtimeState *agentRuntime, req agentRequest) {
	if !runtimeState.canceller.cancelRequest(req.TargetID) {
		// 目标已结束或通知迟到：忽略即可，主进程的宽限期会兜底终止传输。
		fmt.Fprintf(os.Stderr, "忽略无效的取消通知：targetId=%d\n", req.TargetID)
	}
}

// agentResponseWriter 串行化响应写出，避免并发请求的响应帧互相穿插。
type agentResponseWriter struct {
	mu     sync.Mutex
	writer *bufio.Writer
}

func newAgentResponseWriter(writer *bufio.Writer) *agentResponseWriter {
	return &agentResponseWriter{writer: writer}
}

func (w *agentResponseWriter) write(resp agentResponse) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return writeResponse(w.writer, resp)
}
