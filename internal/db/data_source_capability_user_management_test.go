package db

import "testing"

// TestDataSourceCapabilityUserManagementIsOptIn 锁定用户管理入口只对已适配的数据源开放；
// 新增支持时必须同时实现 dbuser Provider 并更新此表。
func TestDataSourceCapabilityUserManagementIsOptIn(t *testing.T) {
	enabled := map[string]bool{
		"mysql": true, "goldendb": true, "mariadb": true, "oceanbase": true,
		"postgres": true, "kingbase": true, "highgo": true, "vastbase": true, "opengauss": true, "gaussdb": true,
		"sqlserver": true, "oracle": true, "dameng": true, "clickhouse": true, "tdengine": true,
		"mongodb": true, "redis": true,
	}
	for driver := range sharedDataSourceCapabilityRegistry.Drivers {
		got := ResolveDataSourceCapability(driver).UI.UserManagement
		if got != enabled[driver] {
			t.Errorf("driver %s userManagement=%v want %v", driver, got, enabled[driver])
		}
	}
	if ResolveCustomDataSourceCapability("").UI.UserManagement {
		t.Fatal("custom profile must not enable user management")
	}
}
