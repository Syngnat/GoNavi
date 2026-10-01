package aiservice

import "GoNavi-Wails/internal/ai"

// --- 安全控制 ---

// AIGetSafetyLevel 获取当前安全级别
func (s *Service) AIGetSafetyLevel() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return string(s.safetyLevel)
}

// AISetSafetyLevel 设置安全级别
func (s *Service) AISetSafetyLevel(level string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch ai.SQLPermissionLevel(level) {
	case ai.PermissionReadOnly, ai.PermissionReadWrite, ai.PermissionFull:
		s.safetyLevel = ai.SQLPermissionLevel(level)
	default:
		s.safetyLevel = ai.PermissionReadOnly
	}
	s.guard.SetPermissionLevel(s.safetyLevel)
	_ = s.saveConfig()
}
