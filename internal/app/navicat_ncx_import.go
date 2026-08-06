package app

import (
	"crypto/aes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"

	"github.com/google/uuid"
	"golang.org/x/crypto/blowfish"
)

type navicatTextFunc func(string, map[string]any) string

func navicatText(text navicatTextFunc, key string, params map[string]any) string {
	if text != nil {
		return text(key, params)
	}
	return defaultAppText(key, params)
}

func navicatError(text navicatTextFunc, key string, params map[string]any) error {
	return errors.New(navicatText(text, key, params))
}

func navicatWrapError(text navicatTextFunc, key string, params map[string]any, err error) error {
	message := navicatText(text, key, params)
	if err == nil {
		return errors.New(message)
	}
	return fmt.Errorf("%s: %w", message, err)
}

type navicatNCXDocument struct {
	Connections []navicatNCXConnection `xml:"Connection"`
}

type navicatNCXConnection struct {
	ConnType                string `xml:"ConnType,attr"`
	ConnectionName          string `xml:"ConnectionName,attr"`
	Host                    string `xml:"Host,attr"`
	Port                    string `xml:"Port,attr"`
	Database                string `xml:"Database,attr"`
	DatabaseFileName        string `xml:"DatabaseFileName,attr"`
	UserName                string `xml:"UserName,attr"`
	Password                string `xml:"Password,attr"`
	SavePassword            string `xml:"SavePassword,attr"`
	OraServiceNameType      string `xml:"OraServiceNameType,attr"`
	TNS                     string `xml:"TNS,attr"`
	SSL                     string `xml:"SSL,attr"`
	SSLPGSSLMode            string `xml:"SSL_PGSSLMode,attr"`
	SSLClientKey            string `xml:"SSL_ClientKey,attr"`
	SSLClientCert           string `xml:"SSL_ClientCert,attr"`
	SSLCACert               string `xml:"SSL_CACert,attr"`
	SSLWeakCertValidation   string `xml:"SSL_WeakCertValidation,attr"`
	SSLAllowInvalidHostName string `xml:"SSL_AllowInvalidHostName,attr"`
	SSH                     string `xml:"SSH,attr"`
	SSHHost                 string `xml:"SSH_Host,attr"`
	SSHPort                 string `xml:"SSH_Port,attr"`
	SSHUserName             string `xml:"SSH_UserName,attr"`
	SSHAuthenMethod         string `xml:"SSH_AuthenMethod,attr"`
	SSHPassword             string `xml:"SSH_Password,attr"`
	SSHSavePassword         string `xml:"SSH_SavePassword,attr"`
	SSHPrivateKey           string `xml:"SSH_PrivateKey,attr"`
	HTTPProxy               string `xml:"HTTP_Proxy,attr"`
	HTTPProxyHost           string `xml:"HTTP_Proxy_Host,attr"`
	HTTPProxyPort           string `xml:"HTTP_Proxy_Port,attr"`
	HTTPProxyUserName       string `xml:"HTTP_Proxy_UserName,attr"`
	HTTPProxyPassword       string `xml:"HTTP_Proxy_Password,attr"`
	HTTPProxySavePassword   string `xml:"HTTP_Proxy_SavePassword,attr"`
}

type navicatCryptoV1 struct {
	block         *blowfish.Cipher
	initialVector []byte
}

func isNavicatNCX(content string) bool {
	text := strings.TrimSpace(content)
	return strings.Contains(text, "<Connection") &&
		strings.Contains(text, "ConnType=") &&
		strings.Contains(text, "ConnectionName=")
}

func parseNavicatNCX(content string) ([]connection.SavedConnectionInput, error) {
	return parseNavicatNCXWithText(content, defaultAppText)
}

func parseNavicatNCXWithText(content string, text navicatTextFunc) ([]connection.SavedConnectionInput, error) {
	var doc navicatNCXDocument
	if err := xml.Unmarshal([]byte(content), &doc); err != nil {
		return nil, err
	}

	inputs := make([]connection.SavedConnectionInput, 0, len(doc.Connections))
	for _, item := range doc.Connections {
		input, ok, err := parseNavicatNCXConnectionWithText(item, text)
		if err != nil {
			return nil, err
		}
		if ok {
			inputs = append(inputs, input)
		}
	}
	return inputs, nil
}

func parseNavicatNCXConnection(item navicatNCXConnection) (connection.SavedConnectionInput, bool, error) {
	return parseNavicatNCXConnectionWithText(item, defaultAppText)
}

func parseNavicatNCXConnectionWithText(item navicatNCXConnection, text navicatTextFunc) (connection.SavedConnectionInput, bool, error) {
	configType, defaultPort, supported := resolveNavicatConnectionType(item.ConnType)
	if !supported {
		return connection.SavedConnectionInput{}, false, nil
	}

	connectionID := "conn-" + uuid.New().String()[:8]
	config := connection.ConnectionConfig{
		ID:   connectionID,
		Type: configType,
		Port: parseNavicatInt(item.Port, defaultPort),
		User: strings.TrimSpace(item.UserName),
	}

	if configType == "sqlite" {
		filePath := firstNonEmpty(item.DatabaseFileName, item.Database)
		filePath = strings.TrimSpace(filePath)
		if filePath == "" {
			return connection.SavedConnectionInput{}, false, nil
		}
		config.Host = filePath
		config.Database = filePath
	} else {
		config.Host = strings.TrimSpace(item.Host)
		config.Database = strings.TrimSpace(item.Database)
		if configType == "oracle" && strings.TrimSpace(config.Database) == "" {
			config.Database = strings.TrimSpace(item.TNS)
		}
		if configType == "oracle" && strings.EqualFold(strings.TrimSpace(item.OraServiceNameType), "SID") && strings.TrimSpace(config.Database) != "" {
			// SID 模式：SID 值仅存于 ConnectionParams（go-ora 的 SID 查询参数），
			// Database（服务名）置空避免 DSN path 冗余，语义与内置连接表单一致。
			config.ConnectionParams = "SID=" + strings.TrimSpace(config.Database)
			config.Database = ""
		}
	}

	if configType == "redis" {
		if dbIndex, ok := parseNavicatRedisDatabase(item.Database); ok {
			config.RedisDB = dbIndex
		}
		config.Database = ""
	}

	name := resolveNavicatConnectionName(item, config)

	password, err := decodeNavicatSecretWithText(item.Password, text)
	if err != nil {
		return connection.SavedConnectionInput{}, false, navicatWrapError(text, "file.backend.error.navicat_connection_password_parse_failed", map[string]any{"name": name}, err)
	}
	config.Password = password

	applyNavicatSSLConfig(&config, item)

	sshPassword, err := decodeNavicatSecretWithText(item.SSHPassword, text)
	if err != nil {
		return connection.SavedConnectionInput{}, false, navicatWrapError(text, "file.backend.error.navicat_connection_ssh_password_parse_failed", map[string]any{"name": name}, err)
	}
	applyNavicatSSHConfig(&config, item, sshPassword)

	proxyPassword, err := decodeNavicatSecretWithText(item.HTTPProxyPassword, text)
	if err != nil {
		return connection.SavedConnectionInput{}, false, navicatWrapError(text, "file.backend.error.navicat_connection_proxy_password_parse_failed", map[string]any{"name": name}, err)
	}
	applyNavicatHTTPProxyConfig(&config, item, proxyPassword)

	return connection.SavedConnectionInput{
		ID:     connectionID,
		Name:   name,
		Config: config,
	}, true, nil
}

func resolveNavicatConnectionType(raw string) (string, int, bool) {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "MYSQL":
		return "mysql", 3306, true
	case "MARIADB":
		return "mariadb", 3306, true
	case "POSTGRES", "POSTGRESQL":
		return "postgres", 5432, true
	case "SQLSERVER", "MSSQL":
		return "sqlserver", 1433, true
	case "SQLITE", "SQLITE3":
		return "sqlite", 0, true
	case "ORACLE":
		return "oracle", 1521, true
	case "REDIS":
		return "redis", 6379, true
	case "MONGODB", "MONGO":
		return "mongodb", 27017, true
	case "CLICKHOUSE":
		return "clickhouse", 9000, true
	case "DAMENG", "DM":
		return "dameng", 5236, true
	default:
		return "", 0, false
	}
}

func resolveNavicatConnectionName(item navicatNCXConnection, config connection.ConnectionConfig) string {
	name := strings.TrimSpace(item.ConnectionName)
	if name != "" {
		return name
	}
	if config.Type == "sqlite" {
		return strings.TrimSpace(config.Database)
	}
	if strings.TrimSpace(config.User) != "" && strings.TrimSpace(config.Host) != "" {
		return fmt.Sprintf("%s@%s:%d", strings.TrimSpace(config.User), strings.TrimSpace(config.Host), config.Port)
	}
	return strings.TrimSpace(config.Host)
}

func parseNavicatInt(raw string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func parseNavicatBool(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func parseNavicatRedisDatabase(raw string) (int, bool) {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < 0 {
		return 0, false
	}
	return value, true
}

func applyNavicatSSLConfig(config *connection.ConnectionConfig, item navicatNCXConnection) {
	useSSL := parseNavicatBool(item.SSL)
	if !useSSL {
		return
	}
	config.UseSSL = true
	config.SSLCAPath = strings.TrimSpace(item.SSLCACert)
	config.SSLCertPath = strings.TrimSpace(item.SSLClientCert)
	config.SSLKeyPath = strings.TrimSpace(item.SSLClientKey)

	if parseNavicatBool(item.SSLWeakCertValidation) || parseNavicatBool(item.SSLAllowInvalidHostName) {
		config.SSLMode = "skip-verify"
		return
	}

	if config.Type == "postgres" {
		config.SSLMode = resolveNavicatPostgresSSLMode(item.SSLPGSSLMode)
		if strings.TrimSpace(config.SSLMode) == "" {
			config.SSLMode = "required"
		}
		return
	}

	config.SSLMode = "required"
}

func resolveNavicatPostgresSSLMode(raw string) string {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "ALLOW", "PREFER":
		return "preferred"
	case "REQUIRE", "VERIFY-CA", "VERIFY_CA", "VERIFY-FULL", "VERIFY_FULL":
		return "required"
	case "DISABLE":
		return "disable"
	default:
		return ""
	}
}

func applyNavicatSSHConfig(config *connection.ConnectionConfig, item navicatNCXConnection, password string) {
	if !parseNavicatBool(item.SSH) {
		return
	}
	config.UseSSH = true
	config.SSH = connection.SSHConfig{
		Host:     strings.TrimSpace(item.SSHHost),
		Port:     parseNavicatInt(item.SSHPort, 22),
		User:     strings.TrimSpace(item.SSHUserName),
		Password: password,
		KeyPath:  strings.TrimSpace(item.SSHPrivateKey),
	}
}

func applyNavicatHTTPProxyConfig(config *connection.ConnectionConfig, item navicatNCXConnection, password string) {
	if !parseNavicatBool(item.HTTPProxy) {
		return
	}
	config.UseProxy = true
	config.Proxy = connection.ProxyConfig{
		Type:     "http",
		Host:     strings.TrimSpace(item.HTTPProxyHost),
		Port:     parseNavicatInt(item.HTTPProxyPort, 8080),
		User:     strings.TrimSpace(item.HTTPProxyUserName),
		Password: password,
	}
}

func decodeNavicatSecret(raw string) (string, error) {
	return decodeNavicatSecretWithError(raw, navicatError(defaultAppText, "file.backend.error.navicat_secret_decrypt_failed", nil))
}

func decodeNavicatSecretWithText(raw string, text navicatTextFunc) (string, error) {
	return decodeNavicatSecretWithError(raw, navicatError(text, "file.backend.error.navicat_secret_decrypt_failed", nil))
}

func decodeNavicatSecretWithError(raw string, decryptErr error) (string, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", nil
	}
	if !looksLikeNavicatHex(text) {
		return text, nil
	}

	plain, err := decryptNavicatHexSecret(text, decryptErr)
	if err != nil {
		return "", err
	}
	return plain, nil
}

func looksLikeNavicatHex(raw string) bool {
	text := strings.TrimSpace(raw)
	if text == "" || len(text)%2 != 0 {
		return false
	}
	for _, ch := range text {
		if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') {
			continue
		}
		return false
	}
	return true
}

func decryptNavicatHexSecret(raw string, decryptErr error) (string, error) {
	ciphertext, err := hex.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}

	if plaintext, err := decryptNavicatHexSecretV1(ciphertext, decryptErr); err == nil {
		return plaintext, nil
	}
	if plaintext, err := decryptNavicatHexSecretV2(ciphertext, decryptErr); err == nil {
		return plaintext, nil
	}
	return "", decryptErr
}

func newNavicatCryptoV1() (*navicatCryptoV1, error) {
	sum := sha1.Sum([]byte("3DC5CA39"))
	block, err := blowfish.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	initialVector := bytesRepeat(0xFF, block.BlockSize())
	block.Encrypt(initialVector, initialVector)
	return &navicatCryptoV1{
		block:         block,
		initialVector: initialVector,
	}, nil
}

func decryptNavicatHexSecretV1(ciphertext []byte, decryptErr error) (string, error) {
	cryptoV1, err := newNavicatCryptoV1()
	if err != nil {
		return "", err
	}
	return cryptoV1.decrypt(ciphertext, decryptErr)
}

func (c *navicatCryptoV1) decrypt(ciphertext []byte, decryptErr error) (string, error) {
	blockSize := c.block.BlockSize()
	currentVector := append([]byte(nil), c.initialVector...)
	roundBytes := len(ciphertext) / blockSize * blockSize
	plaintext := make([]byte, 0, len(ciphertext))
	decryptedBlock := make([]byte, blockSize)

	for offset := 0; offset < roundBytes; offset += blockSize {
		c.block.Decrypt(decryptedBlock, ciphertext[offset:offset+blockSize])
		plaintext = append(plaintext, xorBytes(decryptedBlock, currentVector)...)
		currentVector = xorBytes(currentVector, ciphertext[offset:offset+blockSize])
	}

	if leftover := len(ciphertext) - roundBytes; leftover > 0 {
		stream := make([]byte, blockSize)
		c.block.Encrypt(stream, currentVector)
		plaintext = append(plaintext, xorBytes(ciphertext[roundBytes:], stream[:leftover])...)
	}

	if !isLikelyNavicatPlaintext(plaintext) {
		return "", decryptErr
	}
	return string(plaintext), nil
}

func decryptNavicatHexSecretV2(ciphertext []byte, decryptErr error) (string, error) {
	block, err := aes.NewCipher([]byte("libcckeylibcckey"))
	if err != nil {
		return "", err
	}
	if len(ciphertext) == 0 || len(ciphertext)%block.BlockSize() != 0 {
		return "", decryptErr
	}

	plaintext := make([]byte, len(ciphertext))
	currentVector := []byte("libcciv libcciv ")
	for offset := 0; offset < len(ciphertext); offset += block.BlockSize() {
		block.Decrypt(plaintext[offset:offset+block.BlockSize()], ciphertext[offset:offset+block.BlockSize()])
		for i := 0; i < block.BlockSize(); i++ {
			plaintext[offset+i] ^= currentVector[i]
		}
		currentVector = ciphertext[offset : offset+block.BlockSize()]
	}

	plaintext, err = stripPKCS7Padding(plaintext, block.BlockSize(), decryptErr)
	if err != nil || !isLikelyNavicatPlaintext(plaintext) {
		return "", decryptErr
	}
	return string(plaintext), nil
}

func stripPKCS7Padding(data []byte, blockSize int, decryptErr error) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, decryptErr
	}
	paddingLength := int(data[len(data)-1])
	if paddingLength <= 0 || paddingLength > blockSize || paddingLength > len(data) {
		return nil, decryptErr
	}
	for _, value := range data[len(data)-paddingLength:] {
		if int(value) != paddingLength {
			return nil, decryptErr
		}
	}
	return data[:len(data)-paddingLength], nil
}

func isLikelyNavicatPlaintext(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	if !utf8.Valid(data) {
		return false
	}
	for _, r := range string(data) {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}

func xorBytes(left, right []byte) []byte {
	limit := len(left)
	if len(right) < limit {
		limit = len(right)
	}
	result := make([]byte, limit)
	for index := 0; index < limit; index++ {
		result[index] = left[index] ^ right[index]
	}
	return result
}

func bytesRepeat(value byte, count int) []byte {
	data := make([]byte, count)
	for index := range data {
		data[index] = value
	}
	return data
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
