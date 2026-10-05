package webserver

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

func normalizeWebAuthPassword(password string) (string, error) {
	normalized := strings.TrimSpace(password)
	if normalized == "" {
		return "", fmt.Errorf("password is required")
	}
	if utf8.RuneCountInString(normalized) < webMinPasswordLength {
		return "", fmt.Errorf("password must be at least %d characters", webMinPasswordLength)
	}
	return normalized, nil
}

func hashPassword(password string) (string, error) {
	normalized, err := normalizeWebAuthPassword(password)
	if err != nil {
		return "", err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	const (
		timeCost    uint32 = 3
		memoryCost  uint32 = 64 * 1024
		parallelism uint8  = 2
		keyLen      uint32 = 32
	)
	key := argon2.IDKey([]byte(normalized), salt, timeCost, memoryCost, parallelism, keyLen)
	return fmt.Sprintf(
		"argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		memoryCost,
		timeCost,
		parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

func verifyPassword(encodedHash string, password string) bool {
	parts := strings.Split(strings.TrimSpace(encodedHash), "$")
	if len(parts) != 5 || parts[0] != "argon2id" || parts[1] != "v=19" {
		return false
	}
	params := strings.Split(parts[2], ",")
	if len(params) != 3 {
		return false
	}
	memoryText := strings.TrimPrefix(params[0], "m=")
	timeText := strings.TrimPrefix(params[1], "t=")
	parallelText := strings.TrimPrefix(params[2], "p=")
	memoryCost, err := strconv.ParseUint(memoryText, 10, 32)
	if err != nil {
		return false
	}
	timeCost, err := strconv.ParseUint(timeText, 10, 32)
	if err != nil {
		return false
	}
	parallelism, err := strconv.ParseUint(parallelText, 10, 8)
	if err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	expectedKey, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	derivedKey := argon2.IDKey(
		[]byte(strings.TrimSpace(password)),
		salt,
		uint32(timeCost),
		uint32(memoryCost),
		uint8(parallelism),
		uint32(len(expectedKey)),
	)
	return subtle.ConstantTimeCompare(derivedKey, expectedKey) == 1
}

func readSessionCookie(r *http.Request) (string, bool) {
	if r == nil {
		return "", false
	}
	cookie, err := r.Cookie(webSessionCookieName)
	if err != nil {
		return "", false
	}
	value := strings.TrimSpace(cookie.Value)
	return value, value != ""
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, sessionID string, cfg webAuthConfig, now time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     webSessionCookieName,
		Value:    sessionID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   isSecureRequest(r),
		Expires:  now.Add(cfg.RememberDuration()),
		MaxAge:   int(cfg.RememberDuration().Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     webSessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   isSecureRequest(r),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

func isSecureRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Ssl")), "on")
}

// webTrustedProxiesEnvName 配置可信反向代理的 IP / CIDR 列表（逗号分隔）。
// 只有当直连对端命中该列表时，X-Forwarded-For 才会被采信。
const webTrustedProxiesEnvName = "GONAVI_WEB_TRUSTED_PROXIES"

var (
	trustedProxyOnce sync.Once
	trustedProxyNets []*net.IPNet
)

func loadTrustedProxyNets() []*net.IPNet {
	trustedProxyOnce.Do(func() {
		raw := strings.TrimSpace(os.Getenv(webTrustedProxiesEnvName))
		if raw == "" {
			return
		}
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if _, network, err := net.ParseCIDR(part); err == nil && network != nil {
				trustedProxyNets = append(trustedProxyNets, network)
				continue
			}
			if ip := net.ParseIP(part); ip != nil {
				bits := 32
				if ip.To4() == nil {
					bits = 128
				}
				trustedProxyNets = append(trustedProxyNets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			}
		}
	})
	return trustedProxyNets
}

func isTrustedProxyAddr(text string) bool {
	ip := net.ParseIP(strings.TrimSpace(text))
	if ip == nil {
		return false
	}
	for _, network := range loadTrustedProxyNets() {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// peerIP 返回不可伪造的直连对端地址。
func peerIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && strings.TrimSpace(host) != "" {
		return strings.TrimSpace(host)
	}
	return strings.TrimSpace(r.RemoteAddr)
}

// clientIP 返回用于登录限流与锁定的客户端标识。
//
// 必须以不可伪造的对端地址为准：X-Forwarded-For 完全由客户端控制，原实现无条件采信其首值，
// 直连攻击者每次请求换一个值即可拿到全新的限流桶，从而彻底绕过 5 次失败锁定
// （口令下限仅 webMinPasswordLength=6，可在线爆破），并使 attempts map 无界增长；
// 同时每次尝试都会在校验路径上触发一次 64 MiB 的 Argon2id 推导，形成认证面的 CPU/内存 DoS。
//
// 仅当对端 IP 命中 GONAVI_WEB_TRUSTED_PROXIES 时，才从 X-Forwarded-For 里取「最右侧的
// 非可信跳」作为真实客户端——右侧是代理追加的、可信的部分，左侧可被客户端预先伪造。
func clientIP(r *http.Request) string {
	peer := peerIP(r)
	if peer == "" || !isTrustedProxyAddr(peer) {
		return peer
	}
	parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if candidate == "" || isTrustedProxyAddr(candidate) {
			continue
		}
		if net.ParseIP(candidate) == nil {
			// 非法值不予采信，避免攻击者用任意字符串制造新的限流桶。
			continue
		}
		return candidate
	}
	return peer
}
