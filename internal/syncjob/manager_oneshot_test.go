package syncjob

import (
	"context"
	"testing"
	"time"
)

func putScheduledTestJob(t *testing.T, store *Store, intervalSeconds int64, anchor time.Time) JobDefinition {
	t.Helper()
	definition, err := store.PutJob(context.Background(), JobDefinition{
		Name:            "scheduled sync",
		Enabled:         true,
		Kind:            JobKindReconcile,
		IncrementalMode: IncrementalSnapshot,
		Source:          EndpointRef{ConnectionID: "source"},
		Target:          EndpointRef{ConnectionID: "target"},
		Mappings:        []TableMapping{{SourceTable: "orders", TargetTable: "orders", Enabled: true}},
		Schedule: ScheduleSpec{
			Kind:            ScheduleInterval,
			IntervalSeconds: intervalSeconds,
			AnchorAt:        anchor.UnixMilli(),
		},
	})
	if err != nil {
		t.Fatalf("put scheduled test job: %v", err)
	}
	return definition
}

func TestEnqueueDueJobRunExecutesTargetRunToTerminal(t *testing.T) {
	store := openTestStore(t)
	created := time.Now()
	definition := putScheduledTestJob(t, store, 60, created)
	started := make(chan string, 1)
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		started <- request.Run.ID
		return ExecutionOutcome{RowsInserted: 1}, nil
	})
	// Now 前移 10 分钟：任务的 NextRunAt（创建后 60 秒）必然到期。
	// SchedulerDisabled 与一次性执行进程一致：调度循环启动时会立刻扫描到期任务并抢先入队，
	// 与下面显式的 EnqueueDueJobRun 竞争，导致 enqueued 为 false 或返回已完成的运行。
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerDisabled: true,
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
		Now:               func() time.Time { return created.Add(10 * time.Minute) },
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown manager: %v", err)
		}
	})

	run, enqueued, err := manager.EnqueueDueJobRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("enqueue due job run: %v", err)
	}
	if !enqueued {
		t.Fatal("到期任务应被入队")
	}
	if run.ID == "" || run.Status != RunStatusQueued {
		t.Fatalf("入队运行状态 = %q, 期望 queued", run.Status)
	}
	select {
	case got := <-started:
		if got != run.ID {
			t.Fatalf("执行运行 = %q, 期望 %q", got, run.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("运行未被调度执行")
	}
	final, err := manager.WaitRun(context.Background(), run.ID, 5*time.Millisecond)
	if err != nil {
		t.Fatalf("wait run: %v", err)
	}
	if final.Status != RunStatusSucceeded {
		t.Fatalf("终态 = %q, 期望 succeeded", final.Status)
	}
}

// 调度器关闭的管理器只执行显式入队的运行，不会自己扫描并入队到期任务
// （一次性进程不应顺带拉起其他到期任务，持续型任务更归在线主应用）。
func TestSchedulerDisabledManagerDoesNotEnqueueDueJobsOnItsOwn(t *testing.T) {
	store := openTestStore(t)
	created := time.Now()
	definition := putScheduledTestJob(t, store, 60, created)
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		t.Errorf("调度器关闭时不应自行执行运行：%s", request.Run.ID)
		return ExecutionOutcome{}, nil
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerDisabled: true,
		SchedulerInterval: time.Millisecond,
		HeartbeatInterval: time.Hour,
		Now:               func() time.Time { return created.Add(10 * time.Minute) },
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown manager: %v", err)
		}
	})

	// 调度循环若开启，首轮扫描在启动时立即发生，之后每毫秒再扫一次；留足时间让它有机会入队。
	time.Sleep(300 * time.Millisecond)
	runs, err := store.ListRuns(context.Background(), definition.ID, 10)
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 0 {
		t.Fatalf("调度器关闭的管理器自行入队了 %d 个运行，期望 0", len(runs))
	}
}

func TestEnqueueDueJobRunSkipsNotDueAndUnknownJobs(t *testing.T) {
	store := openTestStore(t)
	created := time.Now()
	definition := putScheduledTestJob(t, store, 3600, created)
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		t.Errorf("不应执行任何运行：%s", request.Run.ID)
		return ExecutionOutcome{}, nil
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
		// Now 仅前移 10 秒：NextRunAt（创建后 1 小时）未到期。
		Now: func() time.Time { return created.Add(10 * time.Second) },
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown manager: %v", err)
		}
	})

	_, enqueued, err := manager.EnqueueDueJobRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("enqueue not-due job: %v", err)
	}
	if enqueued {
		t.Fatal("未到期任务不应入队")
	}
	_, enqueued, err = manager.EnqueueDueJobRun(context.Background(), "missing-job")
	if err != nil {
		t.Fatalf("enqueue unknown job: %v", err)
	}
	if enqueued {
		t.Fatal("未知任务不应入队")
	}
}
