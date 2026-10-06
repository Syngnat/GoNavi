package app

import (
	"fmt"
	"strings"
)

func otherWindowsUpdateProcessIDs(processes []windowsUpdateProcess) []uint32 {
	result := make([]uint32, 0, len(processes))
	for _, process := range processes {
		result = append(result, process.PID)
	}
	return result
}

// interactiveWindowsUpdateProcesses 返回有界面窗口的实例：只有它们可能带着未保存内容，关闭前要用户确认。
func interactiveWindowsUpdateProcesses(processes []windowsUpdateProcess) []windowsUpdateProcess {
	result := make([]windowsUpdateProcess, 0, len(processes))
	for _, process := range processes {
		if process.Interactive {
			result = append(result, process)
		}
	}
	return result
}

// windowsUpdateCloseConfirmationRequired 判断安装更新前是否要用户确认关闭其他 GoNavi 窗口；
// interactiveInstanceCount 只统计有界面窗口的实例，无头的后台进程不计入。
func windowsUpdateCloseConfirmationRequired(goos string, confirmed bool, interactiveInstanceCount int) bool {
	return strings.EqualFold(strings.TrimSpace(goos), "windows") && !confirmed && interactiveInstanceCount > 0
}

func closeOtherWindowsUpdateInstancesForInstall(targetPaths []string, currentPID int) ([]uint32, error) {
	instances, err := updateFindOtherWindowsInstances(targetPaths, currentPID)
	if err != nil {
		return nil, err
	}
	pids := otherWindowsUpdateProcessIDs(instances)
	if len(instances) == 0 {
		return pids, nil
	}
	if err := updateCloseWindowsInstances(instances); err != nil {
		return pids, err
	}
	remaining, err := updateFindOtherWindowsInstances(targetPaths, currentPID)
	if err != nil {
		return pids, err
	}
	if len(remaining) > 0 {
		return pids, fmt.Errorf("GoNavi processes still running after close: %v", otherWindowsUpdateProcessIDs(remaining))
	}
	return pids, nil
}
