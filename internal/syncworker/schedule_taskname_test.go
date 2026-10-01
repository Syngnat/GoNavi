package syncworker

import (
	"strings"
	"testing"
)

func TestJobScheduleTaskName(t *testing.T) {
	base := JobScheduleTaskName("C:\\data\\gonavi", "job-1")
	if !strings.HasPrefix(base, "GoNaviSync-Job-") {
		t.Fatalf("任务名前缀不符：%q", base)
	}
	if len(base) != len("GoNaviSync-Job-")+16 {
		t.Fatalf("任务名哈希长度不符：%q", base)
	}
	if base == JobScheduleTaskName("C:\\data\\gonavi", "job-2") {
		t.Fatal("不同任务的任务名不应相同")
	}
	if base != JobScheduleTaskName("C:\\data\\gonavi\\", "job-1") {
		t.Fatal("数据根的尾部路径分隔符不应影响任务名")
	}
	if base != JobScheduleTaskName("C:/data/gonavi/", "job-1") {
		t.Fatal("正斜杠与反斜杠应得到同一任务名")
	}
	if base == JobScheduleTaskName("C:\\data\\other", "job-1") {
		t.Fatal("不同数据根的任务名不应相同")
	}
}
