package app

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

func normalizeErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return normalizeMixedEncodingText(err.Error())
}

func normalizeMixedEncodingText(text string) string {
	if text == "" {
		return text
	}

	raw := []byte(text)
	output := make([]byte, 0, len(raw)+16)
	suspect := make([]byte, 0, 16)

	flushSuspect := func() {
		if len(suspect) == 0 {
			return
		}

		fallback := strings.ToValidUTF8(string(suspect), "�")
		decoded, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), suspect)
		if err == nil && utf8.Valid(decoded) {
			candidate := string(decoded)
			if scoreDecodedText(candidate) > scoreDecodedText(fallback) {
				output = append(output, []byte(candidate)...)
			} else {
				output = append(output, []byte(fallback)...)
			}
		} else {
			output = append(output, []byte(fallback)...)
		}

		suspect = suspect[:0]
	}

	for len(raw) > 0 {
		r, size := utf8.DecodeRune(raw)
		if r == utf8.RuneError && size == 1 {
			suspect = append(suspect, raw[0])
			raw = raw[1:]
			continue
		}

		if isLikelyMojibakeRune(r) {
			suspect = append(suspect, raw[:size]...)
		} else {
			flushSuspect()
			output = append(output, raw[:size]...)
		}
		raw = raw[size:]
	}

	flushSuspect()
	return string(output)
}

func isLikelyMojibakeRune(r rune) bool {
	if r == utf8.RuneError {
		return true
	}
	if r >= 0x00C0 && r <= 0x02FF {
		return true
	}
	if unicode.In(r, unicode.Hebrew, unicode.Arabic, unicode.Cyrillic, unicode.Greek) {
		return true
	}
	return false
}

func scoreDecodedText(text string) int {
	score := 0
	for _, r := range text {
		switch {
		case r == '�':
			score -= 6
		case unicode.Is(unicode.Han, r):
			score += 4
		case isLikelyMojibakeRune(r):
			score -= 3
		case unicode.IsPrint(r):
			score += 1
		default:
			score -= 2
		}
	}
	return score
}
