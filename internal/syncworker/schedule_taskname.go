package syncworker

import (
	"crypto/sha256"
	"encoding/hex"
	"path"
	"strings"
)

// JobScheduleTaskName 返回某个数据根上某个定时任务的计划任务名。
// 名字确定性派生自 root+jobID：数据根迁移后旧任务可被独立定位与清理。
// 平台无关：注册实现按平台拆分，但任务名规则必须全平台一致，便于测试
// 与跨平台的数据根共享场景。
func JobScheduleTaskName(root, jobID string) string {
	sum := sha256.Sum256([]byte("GoNaviSync-Job\x00" + normalizeScheduleRoot(root) + "\x00" + jobID))
	return "GoNaviSync-Job-" + hex.EncodeToString(sum[:8])
}

// normalizeScheduleRoot 把数据根收成与操作系统无关的形式。
// filepath.Clean 只认本机分隔符，Linux 上会保留 Windows 路径末尾的反斜杠，
// 同一数据根因此得到不同任务名。
func normalizeScheduleRoot(root string) string {
	return path.Clean(strings.ReplaceAll(root, `\`, `/`))
}
