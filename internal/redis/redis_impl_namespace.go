package redis

import (
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/logger"
)

func (r *RedisClientImpl) redisNamespacePrefixForDB(index int) string {
	if !r.isCluster || index <= 0 {
		return ""
	}
	// Redis Cluster 仅支持物理 db0；这里用固定前缀模拟逻辑库隔离。
	return fmt.Sprintf("__gonavi_db_%d__:", index)
}

func (r *RedisClientImpl) redisNamespacePrefix() string {
	return r.redisNamespacePrefixForDB(r.currentDB)
}

func (r *RedisClientImpl) toPhysicalKey(key string) string {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return ""
	}
	prefix := r.redisNamespacePrefix()
	if prefix == "" || strings.HasPrefix(trimmed, prefix) {
		return trimmed
	}
	return prefix + trimmed
}

func (r *RedisClientImpl) toPhysicalPattern(pattern string) string {
	normalized := strings.TrimSpace(pattern)
	if normalized == "" {
		normalized = "*"
	}
	prefix := r.redisNamespacePrefix()
	if prefix == "" {
		return normalized
	}
	return prefix + normalized
}

func redisGlobPatternLiteralKey(pattern string) (string, bool) {
	if pattern == "" {
		return "", false
	}

	var builder strings.Builder
	for i := 0; i < len(pattern); i++ {
		char := pattern[i]
		if char == '\\' {
			if i+1 >= len(pattern) {
				return "", false
			}
			i++
			builder.WriteByte(pattern[i])
			continue
		}
		if char == '*' || char == '?' || char == '[' {
			return "", false
		}
		builder.WriteByte(char)
	}
	return builder.String(), true
}

func escapeRedisGlobLiteral(value string) string {
	var builder strings.Builder
	for i := 0; i < len(value); i++ {
		char := value[i]
		if char == '*' || char == '?' || char == '[' || char == ']' || char == '\\' {
			builder.WriteByte('\\')
		}
		builder.WriteByte(char)
	}
	return builder.String()
}

func redisExactSearchPattern(literalKey string) (string, string) {
	return literalKey, escapeRedisGlobLiteral(literalKey) + ":*"
}

func (r *RedisClientImpl) toPhysicalKeys(keys []string) []string {
	if len(keys) == 0 {
		return nil
	}
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		physical := r.toPhysicalKey(key)
		if physical == "" {
			continue
		}
		result = append(result, physical)
	}
	return result
}

func (r *RedisClientImpl) toDisplayKey(key string) string {
	prefix := r.redisNamespacePrefix()
	if prefix == "" {
		return key
	}
	return strings.TrimPrefix(key, prefix)
}

// sanitizeRedisPassword 对 Redis 密码进行防御性 URL 解码。
// 当密码中包含 URL 编码序列（如 %40）时，尝试解码还原原始字符。
// 这可以防止前端 URI 构建中 encodeURIComponent 编码后的密码被误传入。
func sanitizeRedisPassword(password string) string {
	if password == "" {
		return password
	}
	// 仅当密码中包含 '%' 且后跟两位十六进制数字时，才尝试 URL 解码
	if !strings.Contains(password, "%") {
		return password
	}
	decoded, err := url.QueryUnescape(password)
	if err != nil {
		// 解码失败，使用原始密码
		return password
	}
	if decoded != password {
		logger.Warnf("Redis 密码检测到 URL 编码，已自动解码（原长度=%d 解码后长度=%d）", len(password), len(decoded))
	}
	return decoded
}
