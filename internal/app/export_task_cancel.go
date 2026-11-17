package app

import (
	"context"
	"errors"
	"io"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// errExportTaskNotFound 表示当前没有正在运行的同名导出任务。
var errExportTaskNotFound = errors.New("export task not found")

// exportTaskRegistration 是一个进行中导出任务的取消句柄。注册项由任务自身
// 持有直到完全退出，指针身份即任务身份：finish 只清理自己登记的那一项，
// 同 jobID 的新任务顶替旧项后，迟到的大扫除不会误删新任务。
type exportTaskRegistration struct {
	cancel           context.CancelFunc
	cancelDispatched bool
	strict           bool // Plugin tasks retain their slot until the operation exits.
}

// beginCancelableExportTask 为一次桌面导出登记可取消任务，返回任务 ctx 与
// 必须调用一次的 finish。jobID 为空时返回不可取消的 Background ctx，行为与
// 历史版本一致。取消是协作式的：分发信号后由导出管线在行间检查并收尾。
func (a *App) beginCancelableExportTask(jobID string) (context.Context, func()) {
	jobID = strings.TrimSpace(jobID)
	if a == nil || jobID == "" {
		return context.Background(), func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	registration := &exportTaskRegistration{cancel: cancel}
	if !a.registerExportTask(jobID, registration) {
		cancel()
		return ctx, func() {}
	}
	return ctx, func() { a.finishExportTask(jobID, registration) }
}

// registerExportTask 登记任务；同名任务尚在运行时顶替其登记
// （上层 runner 已保证同一进度任务不会并发运行，这里仍做兜底：
// 顶替旧任务时先分发取消信号，避免旧任务继续写同一目标文件）。
func (a *App) registerExportTask(jobID string, registration *exportTaskRegistration) bool {
	if a == nil {
		return false
	}
	a.exportTaskMu.Lock()
	defer a.exportTaskMu.Unlock()
	if a.exportTasks == nil {
		a.exportTasks = make(map[string]*exportTaskRegistration)
	}
	if current := a.exportTasks[jobID]; current != nil {
		if current.strict {
			return false
		}
		// 同名任务顶替前先取消旧任务，避免旧任务继续向同一目标写文件。
		if current.cancel != nil && !current.cancelDispatched {
			current.cancelDispatched = true
			current.cancel()
		}
	}
	a.exportTasks[jobID] = registration
	return true
}

// finishExportTask 注销任务并释放 ctx 资源。取消已分发时无需重复调用
// cancel；normalPath 的 cancel 调用防止 context 泄漏。
func (a *App) finishExportTask(jobID string, registration *exportTaskRegistration) {
	if a == nil || registration == nil {
		return
	}
	a.exportTaskMu.Lock()
	if current, exists := a.exportTasks[jobID]; exists && current == registration {
		delete(a.exportTasks, jobID)
	}
	a.exportTaskMu.Unlock()
	registration.cancel()
}

// requestExportTaskCancellation 对运行中的导出任务分发一次取消信号。
// 重复请求幂等：信号只分发一次，但每次都返回成功。
func (a *App) requestExportTaskCancellation(jobID string) error {
	jobID = strings.TrimSpace(jobID)
	a.exportTaskMu.Lock()
	task, exists := a.exportTasks[jobID]
	if !exists {
		a.exportTaskMu.Unlock()
		return errExportTaskNotFound
	}
	shouldCancel := !task.cancelDispatched
	task.cancelDispatched = true
	a.exportTaskMu.Unlock()
	if shouldCancel && task.cancel != nil {
		task.cancel()
	}
	return nil
}

// CancelExportFile 请求取消一个进行中的桌面导出任务。返回成功表示取消信号
// 已分发；任务随后以「已取消」结果收尾，临时文件由 abort 路径清理。
func (a *App) CancelExportFile(jobID string) connection.QueryResult {
	jobID = strings.TrimSpace(jobID)
	if err := a.requestExportTaskCancellation(jobID); err != nil {
		if errors.Is(err, errExportTaskNotFound) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.task_not_found", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.cancel_requested", nil)}
}

// exportTaskCanceledResult 是任务被取消后的规范化结果：message 走 i18n，
// data.canceled 供前端把取消与一般失败区分开。
func (a *App) exportTaskCanceledResult() connection.QueryResult {
	return connection.QueryResult{
		Success: false,
		Message: a.appText("file.backend.message.export_canceled", nil),
		Data:    map[string]interface{}{"canceled": true},
	}
}

// classifyExportTaskResult 在任务 ctx 已取消时把失败结果规范为取消结果，
// 避免依赖底层错误文本（不同驱动对 context.Canceled 的包装不一致）。
func (a *App) classifyExportTaskResult(ctx context.Context, result connection.QueryResult) connection.QueryResult {
	if result.Success || ctx.Err() == nil {
		return result
	}
	return a.exportTaskCanceledResult()
}

// openCancelableExportTarget 打开导出目标文件：web 路径沿用传输文件；
// 桌面路径写入同目录 .part 临时文件，成功提交时才原子改名到目标路径，
// 取消或失败都不会在目标位置留下半成品。
func openCancelableExportTarget(webTarget *webDownloadTarget, filename string) (io.WriteCloser, *atomicExportTarget, error) {
	if webTarget != nil {
		f, err := webTarget.openFile()
		return f, nil, err
	}
	target, err := createAtomicExportTarget(filename)
	if err != nil {
		return nil, nil, err
	}
	return target.file, target, nil
}

// finishCancelableExportTarget 是成功路径的收尾：提交前复核取消状态，
// 防止「取消发生在写完之后、提交之前」的竞态把已取消任务发布成完整文件。
func finishCancelableExportTarget(ctx context.Context, atomicTarget *atomicExportTarget, f io.Closer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if atomicTarget != nil {
		return atomicTarget.commit(ctx)
	}
	return closeExportFile(f)
}

// commitCancelableExportTarget 是 SQL 导出分支（bufio 缓冲 + atomic target）
// 带取消复核的提交入口。
func commitCancelableExportTarget(ctx context.Context, target *atomicExportTarget) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return target.commit(ctx)
}
