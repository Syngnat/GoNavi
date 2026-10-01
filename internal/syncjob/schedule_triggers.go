package syncjob

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// TaskTriggerKind 是翻译后 OS 计划任务触发器的形态。
//
// 设计原则：OS 触发器只是「唤醒网格」，任务的星期/日期级约束与是否真正到期
// 一律以 store 的 NextRunAt 到期判定为准（runner 打开 store 后会先做到期检查，
// 未到期直接退出）。因此这里的翻译宁可多唤醒、不可漏唤醒，天数级限制一律
// 不映射到触发器上。
type TaskTriggerKind string

const (
	// TaskTriggerTime 在固定时刻触发一次（once）。
	TaskTriggerTime TaskTriggerKind = "time"
	// TaskTriggerDaily 每天（或每 N 天）的固定时刻触发。
	TaskTriggerDaily TaskTriggerKind = "daily"
	// TaskTriggerRepetition 从起点起每天按固定间隔重复触发，直到当天结束。
	TaskTriggerRepetition TaskTriggerKind = "repetition"
)

// TaskTriggerMaxExactDailyTriggers 限制精确映射的每日触发器数量；超过该数量
// 的 cron（分钟×小时的组合过多，通常是高频步进表达式）退化为 repetition。
const TaskTriggerMaxExactDailyTriggers = 24

// TaskTriggerMinRepetitionSeconds / TaskTriggerMaxRepetitionSeconds 约束兜底
// repetition 的间隔：低于 5 分钟会造成频繁的空唤醒进程，高于 1 小时则可能
// 让高频 cron 的执行时刻偏移过多（到期后由下次唤醒补跑）。
const (
	TaskTriggerMinRepetitionSeconds int64 = 300
	TaskTriggerMaxRepetitionSeconds int64 = 3600
)

type TaskTrigger struct {
	Kind TaskTriggerKind
	// StartAt 对 time/repetition 是确切触发（起点）时刻；对 daily 是首次的
	// 当日时刻（时区跟随表达式或系统本地时间）。XML 渲染时带偏移量输出。
	StartAt time.Time
	// DaysInterval 仅 daily：每几天触发一次（1=每天）。0 视为 1。
	DaysInterval int
	// RepetitionIntervalSeconds 仅 repetition：当日内重复间隔。
	RepetitionIntervalSeconds int64
}

// TaskTriggersForSchedule 把任务的调度描述翻译为 OS 计划任务触发器列表。
// manual/continuous 不产生 OS 触发器（前者无调度，后者仅在应用运行期间由
// 进程内调度器处理），返回 (nil, nil)。
func TaskTriggersForSchedule(spec ScheduleSpec, now time.Time) ([]TaskTrigger, error) {
	switch spec.Kind {
	case ScheduleManual, ScheduleContinuous:
		return nil, nil
	case ScheduleOnce:
		if spec.RunAt <= 0 {
			return nil, errors.New("once schedule requires runAt")
		}
		return []TaskTrigger{{Kind: TaskTriggerTime, StartAt: time.UnixMilli(spec.RunAt)}}, nil
	case ScheduleInterval:
		return intervalTaskTriggers(spec, now)
	case ScheduleCron:
		return cronTaskTriggers(spec, now)
	default:
		return nil, fmt.Errorf("unsupported schedule kind %q", spec.Kind)
	}
}

func intervalTaskTriggers(spec ScheduleSpec, now time.Time) ([]TaskTrigger, error) {
	if spec.IntervalSeconds <= 0 {
		return nil, errors.New("interval schedule requires intervalSeconds")
	}
	if spec.IntervalSeconds%86400 == 0 {
		// 整天间隔：映射为每 N 天的 daily 触发。锚点决定日期相位——StartAt
		// 必须落在锚点 + k*N 天的网格上，否则主应用关闭期间任务会在错误的
		// 日期被执行并把错位固化下来。
		days := int(spec.IntervalSeconds / 86400)
		startAt := nextDailyOccurrence(now, now)
		if spec.AnchorAt > 0 {
			startAt = nextAlignedOccurrence(spec, now)
		}
		return []TaskTrigger{{
			Kind:         TaskTriggerDaily,
			StartAt:      startAt,
			DaysInterval: days,
		}}, nil
	}
	if spec.IntervalSeconds > 86400 {
		// 跨天但非整天倍数（如 25 小时）：schtasks 的 repetition 无法表达
		// Interval > Duration，退化为每小时兜底唤醒，正确性由 DB 到期判定保证。
		startAt := nextAlignedOccurrence(spec, now)
		return []TaskTrigger{{
			Kind:                      TaskTriggerRepetition,
			StartAt:                   startAt,
			RepetitionIntervalSeconds: TaskTriggerMaxRepetitionSeconds,
		}}, nil
	}
	// 亚天间隔：daily 起点每天重摆一次 repetition，当日重复到间隔结束。
	startAt := nextAlignedOccurrence(spec, now)
	return []TaskTrigger{{
		Kind:                      TaskTriggerRepetition,
		StartAt:                   startAt,
		RepetitionIntervalSeconds: spec.IntervalSeconds,
	}}, nil
}

// nextAlignedOccurrence 返回锚点网格上晚于 now 的下一次触发时刻：
// anchor + k*interval > now。无锚点时以 now 为锚。
func nextAlignedOccurrence(spec ScheduleSpec, now time.Time) time.Time {
	interval := time.Duration(spec.IntervalSeconds) * time.Second
	anchor := now
	if spec.AnchorAt > 0 {
		anchor = time.UnixMilli(spec.AnchorAt)
		if !anchor.Before(now) {
			return anchor
		}
	}
	elapsed := now.Sub(anchor)
	steps := elapsed/interval + 1
	return anchor.Add(steps * interval)
}

func nextDailyOccurrence(now, clock time.Time) time.Time {
	local := now.In(clock.Location())
	candidate := time.Date(local.Year(), local.Month(), local.Day(),
		clock.Hour(), clock.Minute(), 0, 0, local.Location())
	if !candidate.After(now) {
		candidate = candidate.AddDate(0, 0, 1)
	}
	return candidate
}

func cronTaskTriggers(spec ScheduleSpec, now time.Time) ([]TaskTrigger, error) {
	schedule, err := parseCronSchedule(spec.CronExpression, spec.Timezone)
	if err != nil {
		return nil, err
	}
	hours := sortedKeys(schedule.hours)
	minutes := sortedKeys(schedule.minutes)
	grid := minuteGrid(hours, minutes)
	if len(grid) == 0 {
		return nil, errors.New("cronExpression has no execution time")
	}
	// 组合数超限时退化为 repetition：间隔取网格内的最小间隔（环绕计算），
	// 起点取 cron 的下一次真实触发时刻，保证网格与 cron 时刻对齐。
	if len(grid) > TaskTriggerMaxExactDailyTriggers {
		gapSeconds := smallestGridGapSeconds(grid)
		if gapSeconds < TaskTriggerMinRepetitionSeconds {
			gapSeconds = TaskTriggerMinRepetitionSeconds
		}
		if gapSeconds > TaskTriggerMaxRepetitionSeconds {
			gapSeconds = TaskTriggerMaxRepetitionSeconds
		}
		startAt, err := nextCronTime(spec.CronExpression, spec.Timezone, now)
		if err != nil {
			return nil, err
		}
		return []TaskTrigger{{
			Kind:                      TaskTriggerRepetition,
			StartAt:                   startAt,
			RepetitionIntervalSeconds: gapSeconds,
		}}, nil
	}
	triggers := make([]TaskTrigger, 0, len(grid))
	for _, point := range grid {
		triggers = append(triggers, TaskTrigger{
			Kind: TaskTriggerDaily,
			StartAt: nextDailyOccurrence(now, time.Date(now.Year(), now.Month(), now.Day(),
				point.hour, point.minute, 0, 0, schedule.location)),
		})
	}
	return triggers, nil
}

type gridPoint struct {
	hour   int
	minute int
}

func minuteGrid(hours, minutes []int) []gridPoint {
	grid := make([]gridPoint, 0, len(hours)*len(minutes))
	for _, hour := range hours {
		for _, minute := range minutes {
			grid = append(grid, gridPoint{hour: hour, minute: minute})
		}
	}
	sort.Slice(grid, func(i, j int) bool {
		if grid[i].hour != grid[j].hour {
			return grid[i].hour < grid[j].hour
		}
		return grid[i].minute < grid[j].minute
	})
	return grid
}

// smallestGridGapSeconds 计算网格在一天内的最小相邻间隔（环绕到次日），
// 作为 repetition 间隔，使唤醒网格不落后于 cron 的实际节奏。
func smallestGridGapSeconds(grid []gridPoint) int64 {
	if len(grid) < 2 {
		return 86400
	}
	minutesOfDay := make([]int, 0, len(grid))
	for _, point := range grid {
		minutesOfDay = append(minutesOfDay, point.hour*60+point.minute)
	}
	smallest := int64(1440 - minutesOfDay[len(minutesOfDay)-1] + minutesOfDay[0])
	for i := 1; i < len(minutesOfDay); i++ {
		gap := int64(minutesOfDay[i] - minutesOfDay[i-1])
		if gap > 0 && gap < smallest {
			smallest = gap
		}
	}
	return smallest * 60
}

func sortedKeys(values map[int]struct{}) []int {
	keys := make([]int, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Ints(keys)
	return keys
}
