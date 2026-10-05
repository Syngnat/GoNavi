package db

import (
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
)

// DriverVariantReporter 由描述表数据源实现：连接后报告服务端自报版本与实际采用的驱动版本档位，
// 供连接测试结果与驱动代理连接信息展示。未识别到版本时 serverVersion 为空串。
type DriverVariantReporter interface {
	DriverVariantInfo() (variantID string, serverVersion string)
}

// driverVariantState 是描述表驱动共用的版本档位状态。
type driverVariantState struct {
	variant       datasource.Variant
	serverVersion string
}

// DriverVariantInfo 实现 DriverVariantReporter。
func (s *driverVariantState) DriverVariantInfo() (string, string) {
	if s == nil {
		return "", ""
	}
	return s.variant.ID, s.serverVersion
}

// resolve 按连接上选择的档位与服务端版本确定档位；类型不在描述表时报错，避免静默按默认行为运行。
func (s *driverVariantState) resolve(driverType string, config connection.ConnectionConfig, serverVersion string) error {
	spec, ok := datasource.Lookup(driverType)
	if !ok {
		return fmt.Errorf("data source %q is not declared in the registry", driverType)
	}
	variant, err := spec.ResolveVariant(config.DriverVariant, serverVersion)
	if err != nil {
		return err
	}
	s.variant = variant
	s.serverVersion = strings.TrimSpace(serverVersion)
	return nil
}

// atLeast 报告服务端版本不低于 minimum；版本未知时按当前档位区间下限判断，
// 让用户手选的旧版档位在探测失败时仍关闭新版特性。
func (s *driverVariantState) atLeast(minimum string) bool {
	version := s.serverVersion
	if datasource.ParseServerVersion(version) == nil {
		version = s.variant.MinServer
	}
	if datasource.ParseServerVersion(version) == nil {
		return s.variant.MaxServer == "" || datasource.CompareServerVersions(minimum, s.variant.MaxServer) < 0
	}
	return datasource.CompareServerVersions(version, minimum) >= 0
}

// rewriteURIScheme 把描述表专属 URI scheme（如 tidb://）改写为底层协议的 scheme，
// 让复用的 MySQL/PostgreSQL 解析逻辑可以识别。scheme 不匹配时原样返回。
func rewriteURIScheme(config connection.ConnectionConfig, target string, aliases ...string) connection.ConnectionConfig {
	text := strings.TrimSpace(config.URI)
	if text == "" {
		return config
	}
	prefix := ""
	if strings.HasPrefix(strings.ToLower(text), "jdbc:") {
		prefix, text = text[:len("jdbc:")], text[len("jdbc:"):]
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return config
	}
	for _, alias := range aliases {
		if strings.EqualFold(parsed.Scheme, alias) {
			parsed.Scheme = target
			config.URI = prefix + parsed.String()
			return config
		}
	}
	return config
}
