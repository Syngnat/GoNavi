package app

import (
	"os"
	"strings"

	"GoNavi-Wails/internal/logger"
)

// pluginLoopbackNoProxy 让插件访问本机服务时绕过代理：插件连本地数据库、本机 RPC
// 都不该经全局代理绕一圈。
const pluginLoopbackNoProxy = "localhost,127.0.0.1,::1"

// mergePluginNoProxy 把回环项并进宿主已有的 NO_PROXY 列表：宿主条目逐条保留（去掉
// 两侧空白与空项）、大小写不敏感去重，缺失的回环项追加在末尾。宿主列表为空时结果就是
// 回环项，因此启用全局代理不会抹掉用户为内网直连配置的绕过项。
func mergePluginNoProxy(hostValues ...string) string {
	entries := make([]string, 0, len(hostValues)+3)
	seen := make(map[string]bool, len(hostValues)+3)
	appendEntry := func(entry string) {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			return
		}
		key := strings.ToLower(trimmed)
		if seen[key] {
			return
		}
		seen[key] = true
		entries = append(entries, trimmed)
	}
	for _, value := range hostValues {
		for _, entry := range strings.Split(value, ",") {
			appendEntry(entry)
		}
	}
	for _, entry := range strings.Split(pluginLoopbackNoProxy, ",") {
		appendEntry(entry)
	}
	return strings.Join(entries, ",")
}

// pluginProxyEnvironment 把宿主「全局代理」设置翻译成插件子进程的代理环境变量。
// 未启用时返回 nil：插件只继承宿主进程已有的代理环境变量，与宿主自身的「环境/系统
// 代理」行为保持一致，不把用户配置的代理强行套上去。配置不可用时同样返回 nil，让插件
// 退回环境代理，而不是拿到一组指向无效地址的变量。
func pluginProxyEnvironment() []string {
	snapshot := currentGlobalProxyConfig()
	if !snapshot.Enabled {
		return nil
	}
	proxyURL, err := buildProxyURLFromConfig(snapshot.Proxy)
	if err != nil {
		logger.Warnf("全局代理配置无效，插件进程回退环境代理：%v", err)
		return nil
	}
	// 沿用宿主既有约定，代理地址内嵌认证信息（buildProxyURLFromConfig）。代价是
	// 插件子进程能读到这组代理凭据；它读不到 GoNavi 的应用凭据与 RPC token。
	proxy := proxyURL.String()
	return []string{
		"HTTP_PROXY=" + proxy,
		"HTTPS_PROXY=" + proxy,
		"ALL_PROXY=" + proxy,
		"NO_PROXY=" + mergePluginNoProxy(os.Getenv("NO_PROXY"), os.Getenv("no_proxy")),
	}
}
