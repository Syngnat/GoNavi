package uievents

import (
	"context"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type Emitter interface {
	Emit(name string, args ...any)
}

type emitterContextKey struct{}

// wailsEventsContextKey mirrors the key the Wails v2 runtime stores its event
// bus under (see pkg/runtime/runtime.go getEvents). Wails aborts the process
// with log.Fatal when EventsEmit receives a context without it, so callers that
// may run with a plain context (unit tests, early startup) must be able to
// detect that before emitting.
const wailsEventsContextKey = "events"

func WithEmitter(ctx context.Context, emitter Emitter) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if emitter == nil {
		return ctx
	}
	return context.WithValue(ctx, emitterContextKey{}, emitter)
}

func emitterFromContext(ctx context.Context) Emitter {
	if ctx == nil {
		return nil
	}
	if emitter, ok := ctx.Value(emitterContextKey{}).(Emitter); ok && emitter != nil {
		return emitter
	}
	return nil
}

// CanEmit reports whether Emit has somewhere to deliver events: either an
// injected Emitter or a live Wails runtime context.
func CanEmit(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	if emitterFromContext(ctx) != nil {
		return true
	}
	return ctx.Value(wailsEventsContextKey) != nil
}

// EmitWith 优先使用 requestCtx 上的 emitter（Web 请求可注入只发给当前会话的
// emitter），没有时回退到 fallback。这样请求内产生的进度事件不会广播给
// 所有浏览器，而后台任务仍走全局 emitter。
func EmitWith(requestCtx context.Context, fallback context.Context, name string, args ...any) {
	if requestCtx != nil {
		if emitter := emitterFromContext(requestCtx); emitter != nil {
			emitter.Emit(name, args...)
			return
		}
	}
	Emit(fallback, name, args...)
}

func Emit(ctx context.Context, name string, args ...any) {
	if ctx == nil {
		return
	}
	if emitter := emitterFromContext(ctx); emitter != nil {
		emitter.Emit(name, args...)
		return
	}
	if ctx.Value(wailsEventsContextKey) == nil {
		// Plain context (tests, pre-startup): dropping the event is preferable to
		// the fatal exit the Wails runtime would trigger.
		return
	}
	wailsRuntime.EventsEmit(ctx, name, args...)
}
