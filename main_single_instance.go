package main

import (
	"context"
	"sync"
)

// singleInstanceActivationState 持有 Wails runtime context，供次实例激活时
// 将主窗口唤起到前台。仅需在 OnStartup 后可用，OnShutdown 后失效。
type singleInstanceActivationState struct {
	mu      sync.Mutex
	ctx     context.Context
	pending bool
	stopped bool
}

// start 绑定 Wails runtime context，并返回冷启动期间是否收到过激活请求。
func (s *singleInstanceActivationState) start(ctx context.Context) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return false
	}
	s.ctx = ctx
	pending := s.pending
	s.pending = false
	return pending
}

// request 请求激活主窗口。Wails context 尚未就绪时记录 pending，由
// OnStartup 补执行；已停止时忽略。
func (s *singleInstanceActivationState) request() context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return nil
	}
	if s.ctx == nil {
		s.pending = true
		return nil
	}
	return s.ctx
}

func (s *singleInstanceActivationState) stop() {
	s.mu.Lock()
	s.ctx = nil
	s.pending = false
	s.stopped = true
	s.mu.Unlock()
}
