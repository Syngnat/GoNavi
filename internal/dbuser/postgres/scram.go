package postgres

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"strconv"
)

// scramIterations 与 libpq PQencryptPasswordConn 默认一致。
const scramIterations = 4096

// isPrehashable 判断口令能否在客户端预计算 verifier：PG 对口令做 SASLprep 规范化，
// 仅纯可打印 ASCII 能保证与服务端结果一致；其余走服务端哈希。
func isPrehashable(password string) bool {
	for index := 0; index < len(password); index++ {
		if password[index] < 0x20 || password[index] > 0x7e {
			return false
		}
	}
	return password != ""
}

// scramSHA256Verifier 生成 PG 格式的 SCRAM-SHA-256 verifier（RFC 5802 / 7677），
// 与 psql \password 的行为一致，使明文口令不出现在服务端 SQL 日志中。
func scramSHA256Verifier(password string, random io.Reader) (string, error) {
	salt := make([]byte, 16)
	if _, err := io.ReadFull(random, salt); err != nil {
		return "", err
	}
	salted, err := pbkdf2.Key(sha256.New, password, salt, scramIterations, sha256.Size)
	if err != nil {
		return "", err
	}
	clientKey := hmacSHA256(salted, "Client Key")
	storedKey := sha256.Sum256(clientKey)
	serverKey := hmacSHA256(salted, "Server Key")
	encode := base64.StdEncoding.EncodeToString
	return "SCRAM-SHA-256$" + strconv.Itoa(scramIterations) + ":" + encode(salt) + "$" + encode(storedKey[:]) + ":" + encode(serverKey), nil
}

// md5Verifier 生成 PG md5 口令：'md5' || md5(password || rolname)。依赖角色名，改名会失效。
func md5Verifier(password, role string) string {
	sum := md5.Sum([]byte(password + role))
	return "md5" + hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, message string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	return mac.Sum(nil)
}

// defaultRandom 是生成 salt 的随机源；测试可替换。
var defaultRandom io.Reader = rand.Reader
