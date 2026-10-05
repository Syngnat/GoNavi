package webserver

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
)

func buildTOTPAccountName(host string) string {
	trimmed := strings.TrimSpace(host)
	if trimmed == "" {
		return "admin@gonavi"
	}
	if parsedHost, _, err := net.SplitHostPort(trimmed); err == nil && strings.TrimSpace(parsedHost) != "" {
		trimmed = parsedHost
	}
	trimmed = strings.TrimSpace(strings.Trim(trimmed, "[]"))
	if trimmed == "" {
		trimmed = "gonavi"
	}
	return "admin@" + trimmed
}

func buildOtpauthURL(issuer string, accountName string, secret string) string {
	normalizedIssuer := strings.TrimSpace(issuer)
	if normalizedIssuer == "" {
		normalizedIssuer = "GoNavi"
	}
	normalizedAccountName := strings.TrimSpace(accountName)
	if normalizedAccountName == "" {
		normalizedAccountName = "admin@gonavi"
	}
	query := url.Values{}
	query.Set("secret", strings.TrimSpace(secret))
	query.Set("issuer", normalizedIssuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", strconv.Itoa(webTOTPDigits))
	query.Set("period", strconv.Itoa(webTOTPPeriodSeconds))
	label := url.PathEscape(normalizedIssuer + ":" + normalizedAccountName)
	return "otpauth://totp/" + label + "?" + query.Encode()
}

func generateQRCodeDataURL(payload string) (string, error) {
	normalized := strings.TrimSpace(payload)
	if normalized == "" {
		return "", fmt.Errorf("qr payload is empty")
	}
	png, err := qrcode.Encode(normalized, qrcode.Medium, 256)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

func generateRandomToken(length int) (string, error) {
	if length <= 0 {
		return "", fmt.Errorf("invalid token length")
	}
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func generateTOTPSecret() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base32NoPadding.EncodeToString(buf), nil
}

func generateRecoveryCodes(count int) ([]string, error) {
	if count <= 0 {
		return []string{}, nil
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	result := make([]string, 0, count)
	random := make([]byte, count*12)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	for index := 0; index < count; index++ {
		chunk := random[index*12 : (index+1)*12]
		var builder strings.Builder
		builder.Grow(14)
		for offset, value := range chunk {
			if offset == 4 || offset == 8 {
				builder.WriteByte('-')
			}
			builder.WriteByte(alphabet[int(value)%len(alphabet)])
		}
		result = append(result, builder.String())
	}
	return result, nil
}

func hashRecoveryCode(code string) string {
	sum := sha256.Sum256([]byte(normalizeUserCode(code)))
	return hex.EncodeToString(sum[:])
}

func consumeRecoveryCode(cfg webAuthConfig, code string) (webAuthConfig, bool) {
	if !cfg.TOTPEnabled || len(cfg.RecoveryCodeHashes) == 0 {
		return cfg, false
	}
	needle := hashRecoveryCode(code)
	next := cloneWebAuthConfig(cfg)
	next.RecoveryCodeHashes = next.RecoveryCodeHashes[:0]
	consumed := false
	for _, item := range cfg.RecoveryCodeHashes {
		if subtle.ConstantTimeCompare([]byte(item), []byte(needle)) == 1 && !consumed {
			consumed = true
			continue
		}
		next.RecoveryCodeHashes = append(next.RecoveryCodeHashes, item)
	}
	return next, consumed
}

func normalizeUserCode(code string) string {
	replacer := strings.NewReplacer(" ", "", "-", "", "\t", "", "\r", "", "\n", "")
	return strings.ToUpper(strings.TrimSpace(replacer.Replace(code)))
}

func validateTOTPCode(secret string, code string, now time.Time) bool {
	normalizedSecret := strings.ToUpper(strings.TrimSpace(secret))
	normalizedCode := normalizeUserCode(code)
	if normalizedSecret == "" || normalizedCode == "" {
		return false
	}
	for offset := -1; offset <= 1; offset++ {
		expected, err := generateTOTPCodeAt(normalizedSecret, now.Add(time.Duration(offset)*webTOTPPeriodSeconds*time.Second))
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(normalizedCode)) == 1 {
			return true
		}
	}
	return false
}

// consumeTOTPCodeForLogin 校验 TOTP 码并登记防重放：同一码在 ±1 步窗口内只接受一次，
// 与恢复码"消费即失效"的标准对齐。纯 validateTOTPCode 本身不记状态，CompleteSetup
// 这类一次性流程继续使用它。
//
// 调用方须持有 m.mu（Login 全程持锁）：本方法不自行加锁，且会在持锁状态下读写
// m.usedTOTPCodes。
//
// 重放码返回 false 而非单独错误：调用方对失败码本就回退到恢复码校验，最终以
// errWebAuthInvalidCredentials 作答，不向探测方泄露"该码曾有效"。
func (m *webAuthManager) consumeTOTPCodeForLogin(secret string, code string, now time.Time) bool {
	if !validateTOTPCode(secret, code, now) {
		return false
	}
	key := totpReplayKey(secret, code)
	// ±1 步窗口意味着最早可在两步后重放同一码，TTL 覆盖两步即可。
	expiresAt := now.Add(2 * webTOTPPeriodSeconds * time.Second)
	if m.usedTOTPCodes == nil {
		m.usedTOTPCodes = make(map[string]time.Time)
	}
	if usedAt, ok := m.usedTOTPCodes[key]; ok && now.Before(usedAt) {
		return false
	}
	m.usedTOTPCodes[key] = expiresAt
	if len(m.usedTOTPCodes) > webUsedTOTPCodeCap {
		m.sweepExpiredTOTPCodesLocked(now)
	}
	return true
}

// totpReplayKey 以 (secret, code) 的哈希作为缓存键：map 里不落明文码，
// 且同一账号轮换 secret 后旧码的键自然失效。
func totpReplayKey(secret string, code string) string {
	sum := sha256.Sum256([]byte(secret + ":" + code))
	return hex.EncodeToString(sum[:])
}

func (m *webAuthManager) sweepExpiredTOTPCodesLocked(now time.Time) {
	for key, expiresAt := range m.usedTOTPCodes {
		if !now.Before(expiresAt) {
			delete(m.usedTOTPCodes, key)
		}
	}
}

func generateTOTPCodeAt(secret string, now time.Time) (string, error) {
	key, err := base32NoPadding.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	counter := uint64(now.Unix() / webTOTPPeriodSeconds)
	var counterBytes [8]byte
	binary.BigEndian.PutUint64(counterBytes[:], counter)
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counterBytes[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binaryCode := (int(sum[offset])&0x7f)<<24 |
		(int(sum[offset+1])&0xff)<<16 |
		(int(sum[offset+2])&0xff)<<8 |
		(int(sum[offset+3]) & 0xff)
	code := binaryCode % 1000000
	return fmt.Sprintf("%06d", code), nil
}
