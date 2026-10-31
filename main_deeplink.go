//go:build !bindings

package main

import (
	"context"
	"sync"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/deeplink"
	"GoNavi-Wails/internal/logger"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// deepLinkWakeEvent tells the front end that the browser sign-in sent the person back: it
// checks the sign-in at once instead of at its next poll.
const deepLinkWakeEvent = "gonavi:deeplink:ai-login"

// deepLinkPluginInstallEvent hands the market website's install request to the front end:
// it opens the plugin workbench tab and prefills the install panel. The payload is a hint
// only; the panel re-parses the spec and inspects before anything is installed.
const deepLinkPluginInstallEvent = "gonavi:deeplink:plugin-install"

// handOffDeepLink is for a process the operating system started for a gonavi:// link. If the
// GoNavi it belongs to is already running, that one is woken and this process should exit
// (true). Otherwise it starts normally (false): a click on the link with GoNavi closed opens it.
func handOffDeepLink(args []string, executablePath string) bool {
	raw, ok := deeplink.FindURLArg(args)
	if !ok || executablePath == "" {
		return false
	}
	// The wake-up signal itself carries no payload, so the link travels in a file the
	// running GoNavi reads when the knock arrives. Without it the knock still works
	// (the window comes forward and the sign-in rechecks), only the install prefill is lost.
	if err := deeplink.StorePending(executablePath, raw); err != nil {
		logger.Warnf("记录 gonavi:// 链接内容失败，运行中的 GoNavi 将只收到唤醒信号：%v", err)
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
	// exePath scopes the pending-link file to this build, matching the wake event's scope.
	exePath string
	mu      sync.Mutex
	ctx     context.Context
}

func (w *deepLinkWaker) bind(ctx context.Context) {
	w.mu.Lock()
	w.ctx = ctx
	w.mu.Unlock()
}

// wake is the Windows knock: the signal has no payload, so the link (if any) comes from
// the pending file. A knock without a link keeps the plain sign-in behavior.
func (w *deepLinkWaker) wake() {
	if raw, ok := deeplink.TakePending(w.exePath); ok {
		w.dispatch(raw)
		return
	}
	w.activator.requestActivation()
	w.emit(deepLinkWakeEvent, nil)
}

// openURL is the macOS path: the system hands the link itself to the running app.
func (w *deepLinkWaker) openURL(raw string) {
	if _, ok := deeplink.Parse(raw); ok {
		w.dispatch(raw)
	}
}

// dispatch routes a raw link to the front end; only recognized links are spoken about.
func (w *deepLinkWaker) dispatch(raw string) {
	w.activator.requestActivation()
	link, ok := deeplink.Parse(raw)
	if !ok {
		return
	}
	if link.Action == deeplink.ActionPluginInstall {
		w.emit(deepLinkPluginInstallEvent, map[string]string{
			"spec": link.Spec,
			"id":   link.PluginID,
			"raw":  raw,
		})
		return
	}
	w.emit(deepLinkWakeEvent, nil)
}

// dispatchPendingLink forwards a link whose cold start opened this GoNavi: the process the
// link launched could not hand itself over (nothing was running), so its link waits in the
// pending file until the front end is ready. Re-sent briefly because a slow first paint can
// otherwise swallow the event; the front end treats repeats of the same link as one.
func (w *deepLinkWaker) dispatchPendingLink() {
	if w == nil || w.exePath == "" {
		return
	}
	raw, ok := deeplink.TakePending(w.exePath)
	if !ok {
		return
	}
	for _, delay := range []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond, 3 * time.Second} {
		time.Sleep(delay)
		w.dispatch(raw)
	}
}

func (w *deepLinkWaker) emit(event string, data map[string]string) {
	w.mu.Lock()
	ctx := w.ctx
	w.mu.Unlock()
	if ctx == nil {
		return
	}
	if data == nil {
		wailsRuntime.EventsEmit(ctx, event)
		return
	}
	wailsRuntime.EventsEmit(ctx, event, data)
}

// startDeepLinks makes this GoNavi the one a gonavi:// link wakes: it listens for processes
// started by a link, and registers itself as the link's handler right away so the plugin
// market website's install button works before any sign-in has ever run (registration is
// idempotent, per user, and a later build takes the scheme over cleanly).
func startDeepLinks(executablePath string, waker *deepLinkWaker) func() {
	if executablePath == "" {
		return func() {}
	}
	stop, err := deeplink.Listen(executablePath, waker.wake)
	if err != nil {
		logger.Warnf("监听浏览器唤醒失败：%v", err)
	}
	if _, err := deeplink.Register(executablePath); err != nil {
		logger.Warnf("注册 gonavi:// 链接失败，市场网站安装按钮将无法唤起 GoNavi：%v", err)
	}
	aiservice.SetBuiltinAILoginStartHook(func() {
		if _, err := deeplink.Register(executablePath); err != nil {
			logger.Warnf("注册 gonavi:// 链接失败，浏览器授权后需手动切回 GoNavi：%v", err)
		}
	})
	return stop
}
