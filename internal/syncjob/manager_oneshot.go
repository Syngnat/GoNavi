package syncjob

import (
	"context"
	"errors"
	"time"
)

// EnqueueDueJobRun 为单个已到期的任务创建调度运行，供一次性执行进程
// （run-sync-job）使用。任务未到期、未启用或不存在时返回 (RunRecord{}, false, nil)。
// 与调度循环的 enqueueScheduled 相同：运行 ID 由 jobID+调度时刻确定性派生，
// 已有在途运行时推进调度并返回 false，由在途运行完成本次到期。
func (m *Manager) EnqueueDueJobRun(ctx context.Context, jobID string) (RunRecord, bool, error) {
	now := m.options.Now()
	dueJobs, err := m.store.ListDueJobs(ctx, now.UnixMilli())
	if err != nil {
		return RunRecord{}, false, err
	}
	var definition JobDefinition
	found := false
	for _, candidate := range dueJobs {
		if candidate.ID == jobID {
			definition = candidate
			found = true
			break
		}
	}
	// 持续型任务由在线主应用的调度器负责，一次性进程不碰。
	if !found || definition.Schedule.Kind == ScheduleContinuous {
		return RunRecord{}, false, nil
	}
	scheduledAt := definition.NextRunAt
	if scheduledAt <= 0 {
		return RunRecord{}, false, nil
	}
	runID := scheduledRunID(definition.ID, scheduledAt)
	run, err := m.createRunWithID(ctx, definition, RunTriggerSchedule, "", 1, runID)
	if err != nil {
		if errors.Is(err, ErrRunAlreadyActive) {
			_, _ = m.store.AdvanceScheduleIfDue(ctx, definition.ID, scheduledAt, now)
			return RunRecord{}, false, nil
		}
		existing, getErr := m.store.GetRun(ctx, runID)
		if getErr != nil {
			return RunRecord{}, false, getErr
		}
		run = existing
	}
	if _, err := m.store.AdvanceScheduleIfDue(ctx, definition.ID, scheduledAt, now); err != nil {
		return RunRecord{}, false, err
	}
	m.signalWake()
	return run, true, nil
}

// WaitRun 轮询等待运行到达终态并返回终态记录；ctx 结束时返回 ctx 错误。
func (m *Manager) WaitRun(ctx context.Context, runID string, pollInterval time.Duration) (RunRecord, error) {
	if pollInterval <= 0 {
		pollInterval = time.Second
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		run, err := m.store.GetRun(ctx, runID)
		if err != nil {
			return RunRecord{}, err
		}
		if terminalRunStatus(run.Status) {
			return run, nil
		}
		select {
		case <-ctx.Done():
			return RunRecord{}, ctx.Err()
		case <-ticker.C:
		}
	}
}
