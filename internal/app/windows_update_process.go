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

func windowsUpdateCloseConfirmationRequired(goos string, confirmed bool, otherInstanceCount int) bool {
	return strings.EqualFold(strings.TrimSpace(goos), "windows") && !confirmed && otherInstanceCount > 0
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
