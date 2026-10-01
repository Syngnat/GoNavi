//go:build windows

package syncworker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"GoNavi-Wails/internal/syncjob"
)


func jobScheduleMarkerPath(root, taskName string) string {
	return filepath.Join(root, "data_sync", "schedules", taskName+".xml")
}

// runSyncJobActionArguments 渲染一次性执行进程的命令行参数。
func runSyncJobActionArguments(root, jobID string) string {
	return syscall.EscapeArg("run-sync-job") +
		" --job " + syscall.EscapeArg(jobID) +
		" --data-root " + syscall.EscapeArg(root)
}

// jobScheduleTaskXML 渲染单个定时任务的计划任务定义。
//
// 与旧常驻模型的区别：没有 LogonTrigger，只有任务自己的日历触发器；
// StartWhenAvailable 兜底睡眠/关机错过的执行，是否真正到期由 runner
// 打开 store 后按 NextRunAt 判定，因此触发器多唤醒是安全的。
func jobScheduleTaskXML(executable, root, jobID, username string, triggers []syncjob.TaskTrigger) (string, error) {
	if len(triggers) == 0 {
		return "", errors.New("job schedule has no os triggers")
	}
	var triggerXML strings.Builder
	for _, trigger := range triggers {
		rendered, err := renderTaskTrigger(trigger)
		if err != nil {
			return "", err
		}
		triggerXML.WriteString(rendered)
	}
	arguments := xmlText(runSyncJobActionArguments(root, jobID))
	return `<?xml version="1.0" encoding="UTF-8"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers>` +
		triggerXML.String() +
		`</Triggers><Principals><Principal id="Author"><UserId>` + xmlText(username) + `</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>` + xmlText(executable) + `</Command><Arguments>` + arguments + `</Arguments></Exec></Actions></Task>`, nil
}

func renderTaskTrigger(trigger syncjob.TaskTrigger) (string, error) {
	startBoundary := trigger.StartAt.Format("2006-01-02T15:04:05Z07:00")
	switch trigger.Kind {
	case syncjob.TaskTriggerTime:
		return `<TimeTrigger><StartBoundary>` + startBoundary + `</StartBoundary><Enabled>true</Enabled></TimeTrigger>`, nil
	case syncjob.TaskTriggerDaily:
		daysInterval := trigger.DaysInterval
		if daysInterval <= 0 {
			daysInterval = 1
		}
		return `<CalendarTrigger><StartBoundary>` + startBoundary + `</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>` + fmt.Sprint(daysInterval) + `</DaysInterval></ScheduleByDay></CalendarTrigger>`, nil
	case syncjob.TaskTriggerRepetition:
		if trigger.RepetitionIntervalSeconds <= 0 {
			return "", errors.New("repetition trigger requires interval")
		}
		interval := formatISO8601DurationSeconds(trigger.RepetitionIntervalSeconds)
		return `<CalendarTrigger><StartBoundary>` + startBoundary + `</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay><Repetition><Interval>` + interval + `</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></CalendarTrigger>`, nil
	default:
		return "", fmt.Errorf("unsupported task trigger kind %q", trigger.Kind)
	}
}

// formatISO8601DurationSeconds 把秒数渲染为 ISO8601 时长（schtasks 只接受
// 分钟以上粒度，余数秒向上取整到分钟）。
func formatISO8601DurationSeconds(seconds int64) string {
	if seconds%60 != 0 {
		seconds += 60 - seconds%60
	}
	if seconds < 60 {
		seconds = 60
	}
	if seconds%3600 == 0 {
		return fmt.Sprintf("PT%dH", seconds/3600)
	}
	return fmt.Sprintf("PT%dM", seconds/60)
}

// RegisterJobSchedule 把单个任务的 OS 计划任务注册（或更新）为与当前调度
// 一致的定义；marker 里保存上次注册成功的编码，内容未变且任务仍在时直接
// 跳过，避免每次启动都重写 schtasks。用户标识与编码候选的回退顺序与旧
// 登录任务注册保持一致（SID 优先、UTF-16 优先）。
func RegisterJobSchedule(ctx context.Context, root, executable, jobID string, spec syncjob.ScheduleSpec) error {
	account, err := user.Current()
	if err != nil {
		return err
	}
	triggers, err := syncjob.TaskTriggersForSchedule(spec, time.Now())
	if err != nil {
		return fmt.Errorf("translate job schedule: %w", err)
	}
	identifiers := taskUserIdentifiers(account)
	if len(identifiers) == 0 {
		return errors.New("current Windows user has no Task Scheduler identifier")
	}
	taskName := JobScheduleTaskName(root, jobID)
	var candidates [][]byte
	for _, identifier := range identifiers {
		definition, err := jobScheduleTaskXML(executable, root, jobID, identifier, triggers)
		if err != nil {
			return fmt.Errorf("render job schedule task: %w", err)
		}
		encoded, err := taskXMLCandidates(definition)
		if err != nil {
			return err
		}
		candidates = append(candidates, encoded...)
	}
	marker := jobScheduleMarkerPath(root, taskName)
	if previous, err := os.ReadFile(marker); err == nil && matchesAnyCandidate(previous, candidates) {
		if err := runSchtasks(ctx, "/Query", "/TN", taskName); err == nil {
			return nil
		}
	}
	content, err := firstAcceptedEncoding(candidates, func(candidate []byte) error {
		return createSchtasksTaskForID(ctx, root, taskName, candidate)
	})
	if err != nil {
		return fmt.Errorf("register job schedule task: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(marker), 0o700); err != nil {
		return err
	}
	return os.WriteFile(marker, content, 0o600)
}

// runSchtasksFn 抽成变量：单测注入桩，验证注销的 Query/Delete 分支而不触
// 真实任务计划程序。
var runSchtasksFn = runSchtasks

// isTaskMissingError 判断 schtasks /Query 的失败是否为「任务不存在」。
// 其它失败（权限、任务计划服务瞬时不可达等）不能当作注销成功处理。
func isTaskMissingError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "cannot find") ||
		strings.Contains(message, "does not exist") ||
		strings.Contains(message, "is not a valid")
}

// UnregisterJobSchedule 移除单个任务的计划任务；任务不存在时视为成功，
// 方便删除任务的路径无条件调用。
func UnregisterJobSchedule(ctx context.Context, root, jobID string) error {
	return UnregisterJobScheduleTaskName(ctx, root, JobScheduleTaskName(root, jobID))
}

// UnregisterJobScheduleTaskName 按任务名移除计划任务；任务不存在时视为成功。
// marker 缺失时也尝试查询并删除，兜住「marker 丢失但 schtasks 任务残留」
// 的孤儿场景。Query 因瞬时原因失败时保留 marker 并静默返回，交给下一轮
// reconcile 的孤儿清扫重试，避免误删后孤儿任务永久不可见。
func UnregisterJobScheduleTaskName(ctx context.Context, root, taskName string) error {
	marker := jobScheduleMarkerPath(root, taskName)
	_, markerErr := os.Stat(marker)
	if markerErr != nil && !errors.Is(markerErr, os.ErrNotExist) {
		return markerErr
	}
	queryErr := runSchtasksFn(ctx, "/Query", "/TN", taskName)
	if queryErr != nil && !isTaskMissingError(queryErr) && markerErr == nil {
		// 任务在册但暂时无法确认：保留 marker，下轮清扫重试。
		return nil
	}
	if queryErr == nil {
		if err := runSchtasksFn(ctx, "/Delete", "/TN", taskName, "/F"); err != nil {
			return fmt.Errorf("remove job schedule task: %w", err)
		}
	}
	if markerErr == nil {
		return os.Remove(marker)
	}
	return nil
}

// UnregisterLegacyLogonTask 清理旧常驻模型的登录任务（GoNaviSync-<root 哈希>），
// 供升级到一次性调度模型的实例在启动时调用；任务不存在时视为成功。
func UnregisterLegacyLogonTask(ctx context.Context, root string) error {
	legacyName := registrationID(root)
	if err := runSchtasks(ctx, "/Query", "/TN", legacyName); err != nil {
		// 任务不存在：已经是目标状态。
		return nil
	}
	if err := runSchtasks(ctx, "/Delete", "/TN", legacyName, "/F"); err != nil {
		return fmt.Errorf("remove legacy sync worker logon task: %w", err)
	}
	_ = os.Remove(filepath.Join(root, "data_sync", "worker-task.xml"))
	return nil
}

// StopLegacyWorker 通知旧常驻 worker 退出（若在运行）。一次性调度模型下
// 升级实例用它完成旧进程的一次性回收。
func StopLegacyWorker(ctx context.Context, root string) error {
	if healthy(ctx, root) {
		return request(ctx, root, "/stop")
	}
	return nil
}

// createSchtasksTaskForID 与 createSchtasksTask 相同，但使用显式任务名。
func createSchtasksTaskForID(ctx context.Context, root, taskName string, content []byte) error {
	// 全新数据根首次注册时 data_sync 目录尚不存在，CreateTemp 前先确保目录在。
	if err := os.MkdirAll(filepath.Join(root, "data_sync"), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Join(root, "data_sync"), "worker-task-*.xml")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(content); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return runSchtasks(ctx, "/Create", "/TN", taskName, "/XML", file.Name(), "/F")
}
