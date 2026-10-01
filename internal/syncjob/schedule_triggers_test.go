package syncjob

import (
	"testing"
	"time"
)

var triggerTestNow = time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)

func TestTaskTriggersForSchedule(t *testing.T) {
	tests := []struct {
		name    string
		spec    ScheduleSpec
		want    []TaskTrigger
		wantErr bool
	}{
		{
			name: "manual 产生空触发器",
			spec: ScheduleSpec{Kind: ScheduleManual},
			want: nil,
		},
		{
			name: "continuous 产生空触发器",
			spec: ScheduleSpec{Kind: ScheduleContinuous},
			want: nil,
		},
		{
			name: "once 映射为一次性时刻触发",
			spec: ScheduleSpec{Kind: ScheduleOnce, RunAt: triggerTestNow.Add(2 * time.Hour).UnixMilli()},
			want: []TaskTrigger{{Kind: TaskTriggerTime, StartAt: triggerTestNow.Add(2 * time.Hour)}},
		},
		{
			name:    "once 缺少 runAt 报错",
			spec:    ScheduleSpec{Kind: ScheduleOnce},
			wantErr: true,
		},
		{
			name: "整天 interval 按锚点对齐日期相位",
			spec: ScheduleSpec{Kind: ScheduleInterval, IntervalSeconds: 7 * 86400, AnchorAt: time.Date(2026, 9, 20, 22, 30, 0, 0, time.UTC).UnixMilli()},
			want: []TaskTrigger{{Kind: TaskTriggerDaily, StartAt: time.Date(2026, 9, 27, 22, 30, 0, 0, time.UTC), DaysInterval: 7}},
		},
		{
			name: "跨天非整天倍数 interval 退化为每小时兜底唤醒",
			spec: ScheduleSpec{Kind: ScheduleInterval, IntervalSeconds: 90000, AnchorAt: triggerTestNow.Add(-time.Hour).UnixMilli()},
			want: []TaskTrigger{{Kind: TaskTriggerRepetition, StartAt: triggerTestNow.Add(-time.Hour).Add(25 * time.Hour), RepetitionIntervalSeconds: 3600}},
		},
		{
			name: "亚天 interval 映射为 repetition 且对齐锚点网格",
			spec: ScheduleSpec{Kind: ScheduleInterval, IntervalSeconds: 900, AnchorAt: triggerTestNow.Add(-25 * time.Minute).UnixMilli()},
			want: []TaskTrigger{{Kind: TaskTriggerRepetition, StartAt: triggerTestNow.Add(-25*time.Minute + 2*15*time.Minute), RepetitionIntervalSeconds: 900}},
		},
		{
			name: "单时刻 cron 映射为单个 daily 触发器",
			spec: ScheduleSpec{Kind: ScheduleCron, CronExpression: "30 8 * * *", Timezone: "UTC"},
			want: []TaskTrigger{{Kind: TaskTriggerDaily, StartAt: time.Date(2026, 9, 25, 8, 30, 0, 0, time.UTC)}},
		},
		{
			name: "多时刻 cron 映射为多个 daily 触发器且按时刻排序",
			spec: ScheduleSpec{Kind: ScheduleCron, CronExpression: "0,30 9 * * *", Timezone: "UTC"},
			want: []TaskTrigger{
				{Kind: TaskTriggerDaily, StartAt: time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)},
				{Kind: TaskTriggerDaily, StartAt: time.Date(2026, 9, 25, 9, 30, 0, 0, time.UTC)},
			},
		},
		{
			name: "日期受限的 cron 仍映射为 daily，由到期判定约束日期",
			spec: ScheduleSpec{Kind: ScheduleCron, CronExpression: "0 0 1 1 *", Timezone: "UTC"},
			want: []TaskTrigger{{Kind: TaskTriggerDaily, StartAt: time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC)}},
		},
		{
			name: "组合数超限的 cron 退化为 repetition 且对齐 cron 网格",
			spec: ScheduleSpec{Kind: ScheduleCron, CronExpression: "*/15 * * * *", Timezone: "UTC"},
			want: []TaskTrigger{{Kind: TaskTriggerRepetition, StartAt: time.Date(2026, 9, 24, 10, 15, 0, 0, time.UTC), RepetitionIntervalSeconds: 900}},
		},
		{
			name:    "非法 cron 表达式报错",
			spec:    ScheduleSpec{Kind: ScheduleCron, CronExpression: "not cron", Timezone: "UTC"},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TaskTriggersForSchedule(tt.spec, triggerTestNow)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("期望报错，实际得到 %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("TaskTriggersForSchedule() error = %v", err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("触发器数量 = %d, 期望 %d (%+v)", len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i].Kind != tt.want[i].Kind {
					t.Errorf("trigger[%d].Kind = %q, 期望 %q", i, got[i].Kind, tt.want[i].Kind)
				}
				if !got[i].StartAt.Equal(tt.want[i].StartAt) {
					t.Errorf("trigger[%d].StartAt = %v, 期望 %v", i, got[i].StartAt, tt.want[i].StartAt)
				}
				if got[i].DaysInterval != tt.want[i].DaysInterval {
					t.Errorf("trigger[%d].DaysInterval = %d, 期望 %d", i, got[i].DaysInterval, tt.want[i].DaysInterval)
				}
				if got[i].RepetitionIntervalSeconds != tt.want[i].RepetitionIntervalSeconds {
					t.Errorf("trigger[%d].RepetitionIntervalSeconds = %d, 期望 %d", i, got[i].RepetitionIntervalSeconds, tt.want[i].RepetitionIntervalSeconds)
				}
			}
		})
	}
}

func TestSmallestGridGapSeconds(t *testing.T) {
	tests := []struct {
		name  string
		grid  []gridPoint
		want  int64
	}{
		{
			name: "单点网格取一整天",
			grid: []gridPoint{{hour: 8, minute: 30}},
			want: 86400,
		},
		{
			name: "相邻点取最小间隔",
			grid: []gridPoint{{hour: 9, minute: 0}, {hour: 9, minute: 30}, {hour: 17, minute: 0}},
			want: 1800,
		},
		{
			name: "跨午夜环绕取最小间隔",
			grid: []gridPoint{{hour: 0, minute: 10}, {hour: 23, minute: 50}},
			want: 1200,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := smallestGridGapSeconds(tt.grid); got != tt.want {
				t.Fatalf("smallestGridGapSeconds() = %d, 期望 %d", got, tt.want)
			}
		})
	}
}
