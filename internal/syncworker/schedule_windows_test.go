//go:build windows

package syncworker

import (
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/syncjob"
)

func TestJobScheduleTaskXML(t *testing.T) {
	executable := "C:\\Program Files\\GoNavi\\GoNavi.exe"
	root := "C:\\Users\\someone\\.gonavi"
	jobID := "job-1"
	username := "DESKTOP\\someone"

	t.Run("once 触发渲染为 TimeTrigger", func(t *testing.T) {
		triggers := []syncjob.TaskTrigger{{Kind: syncjob.TaskTriggerTime, StartAt: time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)}}
		content, err := jobScheduleTaskXML(executable, root, jobID, username, triggers)
		if err != nil {
			t.Fatalf("渲染失败：%v", err)
		}
		if !strings.Contains(content, "<TimeTrigger><StartBoundary>2026-09-24T12:00:00Z</StartBoundary><Enabled>true</Enabled></TimeTrigger>") {
			t.Fatalf("缺少 TimeTrigger：%s", content)
		}
		if !strings.Contains(content, `<Arguments>`+runSyncJobActionArguments(root, jobID)+`</Arguments>`) {
			t.Fatalf("缺少一次性执行参数：%s", content)
		}
		if !strings.Contains(content, "<StartWhenAvailable>true</StartWhenAvailable>") {
			t.Fatalf("缺少错过执行兜底：%s", content)
		}
	})

	t.Run("daily 触发渲染为按天日历", func(t *testing.T) {
		content, err := jobScheduleTaskXML(executable, root, jobID, username, []syncjob.TaskTrigger{
			{Kind: syncjob.TaskTriggerDaily, StartAt: time.Date(2026, 9, 24, 8, 30, 0, 0, time.UTC)},
		})
		if err != nil {
			t.Fatalf("渲染失败：%v", err)
		}
		if !strings.Contains(content, "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>") {
			t.Fatalf("缺少按天调度：%s", content)
		}
		if strings.Contains(content, "<LogonTrigger>") {
			t.Fatal("新模型不应再注册登录触发器")
		}
	})

	t.Run("repetition 触发渲染为按天重复", func(t *testing.T) {
		content, err := jobScheduleTaskXML(executable, root, jobID, username, []syncjob.TaskTrigger{
			{Kind: syncjob.TaskTriggerRepetition, StartAt: time.Date(2026, 9, 24, 10, 15, 0, 0, time.UTC), RepetitionIntervalSeconds: 900},
		})
		if err != nil {
			t.Fatalf("渲染失败：%v", err)
		}
		if !strings.Contains(content, "<Repetition><Interval>PT15M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>") {
			t.Fatalf("缺少按日重复定义：%s", content)
		}
	})

	t.Run("多触发器按顺序渲染", func(t *testing.T) {
		content, err := jobScheduleTaskXML(executable, root, jobID, username, []syncjob.TaskTrigger{
			{Kind: syncjob.TaskTriggerDaily, StartAt: time.Date(2026, 9, 24, 9, 0, 0, 0, time.UTC)},
			{Kind: syncjob.TaskTriggerDaily, StartAt: time.Date(2026, 9, 24, 9, 30, 0, 0, time.UTC)},
		})
		if err != nil {
			t.Fatalf("渲染失败：%v", err)
		}
		if got := strings.Count(content, "<CalendarTrigger>"); got != 2 {
			t.Fatalf("CalendarTrigger 数量 = %d, 期望 2", got)
		}
		if strings.Index(content, "T09:00:00") > strings.Index(content, "T09:30:00") {
			t.Fatal("触发器应保持传入顺序")
		}
	})

	t.Run("空触发器列表报错", func(t *testing.T) {
		if _, err := jobScheduleTaskXML(executable, root, jobID, username, nil); err == nil {
			t.Fatal("空触发器应当报错")
		}
	})
}

func TestFormatISO8601DurationSeconds(t *testing.T) {
	tests := []struct {
		seconds int64
		want    string
	}{
		{seconds: 900, want: "PT15M"},
		{seconds: 3600, want: "PT1H"},
		{seconds: 45, want: "PT1M"},
		{seconds: 86400, want: "PT24H"},
	}
	for _, tt := range tests {
		if got := formatISO8601DurationSeconds(tt.seconds); got != tt.want {
			t.Errorf("formatISO8601DurationSeconds(%d) = %q, 期望 %q", tt.seconds, got, tt.want)
		}
	}
}

func TestRunSyncJobActionArgumentsEscaping(t *testing.T) {
	args := runSyncJobActionArguments("C:\\data root with space", "job with space")
	parts := strings.Split(args, " --job ")
	if len(parts) != 2 {
		t.Fatalf("参数应能按 --job 分割：%q", args)
	}
	if !strings.HasPrefix(parts[0], `"run-sync-job"`) && !strings.HasPrefix(parts[0], "run-sync-job") {
		t.Fatalf("模式参数错误：%q", args)
	}
	if !strings.Contains(args, `"--data-root "`) && !strings.Contains(args, " --data-root ") {
		t.Fatalf("缺少 data-root 参数：%q", args)
	}
}
