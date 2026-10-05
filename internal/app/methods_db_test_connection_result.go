package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
	"GoNavi-Wails/internal/db"
)

// testConnectionVariantInfo 是测试连接成功时附带的服务端版本与驱动版本档位，
// 只有描述表数据源的驱动代理会回报；历史类型返回 nil，结果保持原样。
type testConnectionVariantInfo struct {
	ServerVersion      string `json:"serverVersion,omitempty"`
	DriverVariant      string `json:"driverVariant,omitempty"`
	DriverVariantLabel string `json:"driverVariantLabel,omitempty"`
	RequestedVariant   string `json:"requestedVariant,omitempty"`
	// SuggestedVariant 是与服务端版本匹配、但与用户手动选择不同的档位；匹配时为空。
	SuggestedVariant      string `json:"suggestedVariant,omitempty"`
	SuggestedVariantLabel string `json:"suggestedVariantLabel,omitempty"`
}

// captureTestConnectionVariant 在关闭临时连接前读取代理回报的档位信息。
func captureTestConnectionVariant(config connection.ConnectionConfig, inst db.Database) *testConnectionVariantInfo {
	reporter, ok := inst.(db.DriverVariantReporter)
	if !ok {
		return nil
	}
	variantID, version := reporter.DriverVariantInfo()
	spec, declared := db.DataSourceSpec(config.Type)
	if !declared || (variantID == "" && strings.TrimSpace(version) == "") {
		return nil
	}
	info := &testConnectionVariantInfo{
		ServerVersion:    db.SanitizeServerVersion(version),
		DriverVariant:    variantID,
		RequestedVariant: spec.RequestedVariant(config.DriverVariant),
	}
	if variant, found := spec.Variants.Item(variantID); found {
		info.DriverVariantLabel = variant.Label
	}
	if info.RequestedVariant != datasource.VariantAuto {
		if suggested, matched := spec.MatchVariant(info.ServerVersion); matched && suggested.ID != variantID {
			info.SuggestedVariant, info.SuggestedVariantLabel = suggested.ID, suggested.Label
		}
	}
	return info
}

// testConnectionSuccessResult 生成测试连接成功的结果：描述表数据源在提示里带上服务端版本与实际档位。
func (a *App) testConnectionSuccessResult(config connection.ConnectionConfig, info *testConnectionVariantInfo) connection.QueryResult {
	result := connection.QueryResult{Success: true, Message: a.appText("db.backend.message.connect_success", nil)}
	if info == nil {
		return result
	}
	spec, _ := db.DataSourceSpec(config.Type)
	params := map[string]any{
		"name":      spec.DisplayName,
		"version":   info.ServerVersion,
		"variant":   info.DriverVariantLabel,
		"suggested": info.SuggestedVariantLabel,
	}
	switch {
	case info.SuggestedVariantLabel != "" && info.DriverVariantLabel != "":
		result.Message = a.appText("db.backend.message.connect_success_variant_mismatch", params)
	case info.ServerVersion != "" && info.DriverVariantLabel != "":
		result.Message = a.appText("db.backend.message.connect_success_with_version", params)
	case info.DriverVariantLabel != "":
		result.Message = a.appText("db.backend.message.connect_success_with_variant", params)
	}
	result.Data = info
	return result
}

// reportedServerVersion 返回驱动代理连接时回报的服务端版本。
func reportedServerVersion(inst db.Database) (string, bool) {
	reporter, ok := inst.(db.DriverVariantReporter)
	if !ok {
		return "", false
	}
	_, version := reporter.DriverVariantInfo()
	version = db.SanitizeServerVersion(version)
	return version, version != ""
}

// emptyServerVersionResult 表示数据源没有版本探测：成功且版本为空，AI 回退到保守的方言基线。
func emptyServerVersionResult() connection.QueryResult {
	return connection.QueryResult{
		Success: true,
		Data:    []map[string]interface{}{},
		Fields:  []string{"version"},
	}
}
