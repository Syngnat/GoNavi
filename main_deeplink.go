//go:build !bindings

package main

import (
	"context"
	"sync"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/deeplink"
	"GoNavi-Wails/internal/logger"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// deepLinkWakeEvent tells the front end that the browser sign-in sent the person back: it
// checks the sign-in at once instead of at its next poll.
const deepLinkWakeEvent = "gonavi:deeplink:ai-login"

// handOffDeepLink is for a process the operating system started for a gonavi:// link. If the
// GoNavi it belongs to is already running, that one is woken and this process should exit
// (true). Otherwise it starts normally (false): a click on the link with GoNavi closed opens it.
func handOffDeepLink(args []string, executablePath string) bool {
	if _, ok := deeplink.FindURLArg(args); !ok || executablePath == "" {
		return false
	}
	woken, err := deeplink.SignalRunning(executablePath)
	if err != nil {
		logger.Warnf("唤醒正在运行的 GoNavi 失败：%v", err)
	}
	return woken
}

// deepLinkWaker brings the window forward and tells the front end, once it can.
type deepLinkWaker struct {
	activator *primaryWindowActivator
	mu        sync.Mutex
	ctx       context.Context
}

func (w *deepLinkWaker) bind(ctx context.Context) {
	w.mu.Lock()
	w.ctx = ctx
	w.mu.Unlock()
}

func (w *deepLinkWaker) wake() {
	w.activator.requestActivation()
	w.mu.Lock()
	ctx := w.ctx
	w.mu.Unlock()
	if ctx != nil {
		wailsRuntime.EventsEmit(ctx, deepLinkWakeEvent)
	}
}

// openURL is the macOS path: the system hands the link to the running app.
func (w *deepLinkWaker) openURL(raw string) {
	if _, ok := deeplink.Parse(raw); ok {
		w.wake()
	}
}

// startDeepLinks makes this GoNavi the one a gonavi:// link wakes: it listens for processes
// started by a link, and registers itself as the link's handler whenever a browser sign-in to
// the built-in AI begins (so the GoNavi that waits for the browser is the one that comes back).
func startDeepLinks(executablePath string, waker *deepLinkWaker) func() {
	if executablePath == "" {
		return func() {}
	}
	stop, err := deeplink.Listen(executablePath, waker.wake)
	if err != nil {
		logger.Warnf("监听浏览器唤醒失败：%v", err)
	}
	aiservice.SetBuiltinAILoginStartHook(func() {
		if _, err := deeplink.Register(executablePath); err != nil {
			logger.Warnf("注册 gonavi:// 链接失败，浏览器授权后需手动切回 GoNavi：%v", err)
		}
	})
	return stop
}
