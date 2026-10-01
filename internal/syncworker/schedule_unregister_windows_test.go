//go:build windows

package syncworker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// 注入桩下的注销分支验证：不触真实任务计划程序。
func TestUnregisterJobScheduleTaskNameBranches(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	restore := func() { runSchtasksFn = runSchtasks }
	defer restore()

	t.Run("marker 缺失且任务不存在时视为成功", func(t *testing.T) {
		calls := 0
		runSchtasksFn = func(ctx context.Context, args ...string) error {
			calls++
			return errors.New("schtasks: task does not exist")
		}
		if err := UnregisterJobScheduleTaskName(ctx, root, "GoNaviSync-Job-missing"); err != nil {
			t.Fatalf("注销应视为成功: %v", err)
		}
		if calls != 1 {
			t.Fatalf("Query 调用次数 = %d, 期望 1（Query 失败后不再 Delete）", calls)
		}
	})

	t.Run("marker 存在且任务在册时删除任务与 marker", func(t *testing.T) {
		taskName := "GoNaviSync-Job-present"
		marker := jobScheduleMarkerPath(root, taskName)
		if err := os.MkdirAll(filepath.Dir(marker), 0o700); err != nil {
			t.Fatalf("创建目录: %v", err)
		}
		if err := os.WriteFile(marker, []byte("stub"), 0o600); err != nil {
			t.Fatalf("写入 marker: %v", err)
		}
		calls := 0
		runSchtasksFn = func(ctx context.Context, args ...string) error {
			calls++
			return nil
		}
		if err := UnregisterJobScheduleTaskName(ctx, root, taskName); err != nil {
			t.Fatalf("注销失败: %v", err)
		}
		if calls != 2 {
			t.Fatalf("Query+Delete 调用次数 = %d, 期望 2", calls)
		}
		if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("marker 应被移除, stat err = %v", err)
		}
	})

	t.Run("Delete 失败时保留 marker 供重试", func(t *testing.T) {
		taskName := "GoNaviSync-Job-delete-fails"
		marker := jobScheduleMarkerPath(root, taskName)
		if err := os.WriteFile(marker, []byte("stub"), 0o600); err != nil {
			t.Fatalf("写入 marker: %v", err)
		}
		runSchtasksFn = func(ctx context.Context, args ...string) error {
			if len(args) > 0 && args[0] == "/Delete" {
				return errors.New("schtasks: access denied")
			}
			return nil
		}
		if err := UnregisterJobScheduleTaskName(ctx, root, taskName); err == nil {
			t.Fatal("Delete 失败应返回错误")
		}
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("marker 应保留供重试, stat err = %v", err)
		}
	})

	t.Run("Query 瞬时失败时保留 marker 供清扫重试", func(t *testing.T) {
		taskName := "GoNaviSync-Job-query-flaky"
		marker := jobScheduleMarkerPath(root, taskName)
		if err := os.WriteFile(marker, []byte("stub"), 0o600); err != nil {
			t.Fatalf("写入 marker: %v", err)
		}
		runSchtasksFn = func(ctx context.Context, args ...string) error {
			if len(args) > 0 && args[0] == "/Query" {
				return errors.New("schtasks /Query /TN x: exit status 1: ERROR: The scheduled task is currently busy")
			}
			t.Fatal("Query 失败后不应执行 Delete")
			return nil
		}
		if err := UnregisterJobScheduleTaskName(ctx, root, taskName); err != nil {
			t.Fatalf("瞬时失败应静默返回并保留 marker: %v", err)
		}
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("marker 应保留供清扫重试, stat err = %v", err)
		}
	})
}
