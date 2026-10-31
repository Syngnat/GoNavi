package sessionagent

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 本机图片读取：会话正文里的图片（Codex 的 ![alt](/E:/path/x.png)）与
// Claude 会话的 image 块都指向本机文件。webview 不能直接用路径加载——
// 实测站点相对路径（/E:/...）和 file:// URL 都会被拦掉或 404，图片只剩
// alt 文本。所以由后端把图片读成 data URL 交给前端 <img> 直接显示。
//
// 边界：只读、只认图片扩展名、单文件上限 MaxLocalImageBytes。

// MaxLocalImageBytes 是本机图片的单文件字节上限。
const MaxLocalImageBytes = 8 << 20

// localImageMIME 是允许读取的图片扩展名 → MIME 映射。SVG 用
// image/svg+xml：前端只在 <img> 里用它，浏览器在该上下文禁用 SVG 脚本。
var localImageMIME = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".avif": "image/avif",
	".svg":  "image/svg+xml",
}

// LocalImageMIME 返回路径对应的图片 MIME；不是受支持的图片类型时返回空串。
func LocalImageMIME(path string) string {
	return localImageMIME[strings.ToLower(filepath.Ext(strings.TrimSpace(path)))]
}

// ReadLocalImageDataURL 读取本机图片并返回 data URL。路径必须是绝对路径、
// 扩展名在受支持列表内、文件大小不超过上限。
func ReadLocalImageDataURL(path string) (string, error) {
	cleaned := strings.TrimSpace(path)
	if cleaned == "" {
		return "", fmt.Errorf("图片路径为空")
	}
	if !filepath.IsAbs(cleaned) {
		return "", fmt.Errorf("图片路径必须是绝对路径")
	}
	mime := LocalImageMIME(cleaned)
	if mime == "" {
		return "", fmt.Errorf("不支持的图片类型: %s", filepath.Ext(cleaned))
	}
	info, err := os.Stat(cleaned)
	if err != nil {
		return "", fmt.Errorf("读取图片失败: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("图片路径指向目录")
	}
	if info.Size() > MaxLocalImageBytes {
		return "", fmt.Errorf("图片超过大小上限 %d 字节", MaxLocalImageBytes)
	}
	data, err := os.ReadFile(cleaned)
	if err != nil {
		return "", fmt.Errorf("读取图片失败: %w", err)
	}
	if len(data) > MaxLocalImageBytes {
		return "", fmt.Errorf("图片超过大小上限 %d 字节", MaxLocalImageBytes)
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}
