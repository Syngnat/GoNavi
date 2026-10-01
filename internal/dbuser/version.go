package dbuser

import (
	"regexp"
	"strconv"
	"strings"
)

var dottedVersionPattern = regexp.MustCompile(`(\d+)\.(\d+)(?:\.(\d+))?`)

// ParseDottedVersion 取文本中第一个 x.y[.z] 版本号；找不到时返回只含 Raw 的零版本。
func ParseDottedVersion(text string) Version {
	return parseDottedFrom(text, 0)
}

// ParseDottedVersionAfter 在 marker（大小写不敏感）之后查找版本号，
// 用于 "5.5.5-10.11.6-MariaDB"、"PostgreSQL 16.2 on ..." 这类横幅。
func ParseDottedVersionAfter(text, marker string) Version {
	index := strings.Index(strings.ToLower(text), strings.ToLower(marker))
	if index < 0 {
		return Version{Raw: strings.TrimSpace(text)}
	}
	return parseDottedFrom(text, index+len(marker))
}

func parseDottedFrom(text string, offset int) Version {
	raw := strings.TrimSpace(text)
	if offset > len(text) {
		return Version{Raw: raw}
	}
	match := dottedVersionPattern.FindStringSubmatch(text[offset:])
	if match == nil {
		return Version{Raw: raw}
	}
	return Version{
		Major: atoiOrZero(match[1]),
		Minor: atoiOrZero(match[2]),
		Patch: atoiOrZero(match[3]),
		Raw:   raw,
	}
}

// Known 表示是否解析到了有效版本号。
func (v Version) Known() bool {
	return v.Major > 0 || v.Minor > 0 || v.Patch > 0
}

// AtLeast 判断版本是否不低于 major.minor.patch。未知版本一律视为不满足，
// 调用方据此走保守路径（关闭新特性）。
func (v Version) AtLeast(major, minor, patch int) bool {
	if !v.Known() {
		return false
	}
	if v.Major != major {
		return v.Major > major
	}
	if v.Minor != minor {
		return v.Minor > minor
	}
	return v.Patch >= patch
}

// String 返回 major.minor.patch。
func (v Version) String() string {
	if !v.Known() {
		return v.Raw
	}
	return strconv.Itoa(v.Major) + "." + strconv.Itoa(v.Minor) + "." + strconv.Itoa(v.Patch)
}

func atoiOrZero(text string) int {
	if text == "" {
		return 0
	}
	value, err := strconv.Atoi(text)
	if err != nil {
		return 0
	}
	return value
}
