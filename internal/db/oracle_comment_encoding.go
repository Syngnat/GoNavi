package db

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

// normalizeOracleMetadataComment repairs the specific form of Oracle comment
// mojibake produced when UTF-8 bytes were stored in a ZHS16GBK VARCHAR2 value
// and later decoded as GBK. It deliberately runs only on Oracle metadata
// comments; normal query values must retain their database-defined encoding.
func normalizeOracleMetadataComment(comment string) string {
	if strings.TrimSpace(comment) == "" {
		return comment
	}

	// Re-encode the displayed mojibake as GB18030. For the affected values this
	// recovers the original UTF-8 byte sequence. GB18030 includes GBK, while
	// accepting a few additional characters that may occur in comments.
	recoveredBytes, _, err := transform.Bytes(simplifiedchinese.GB18030.NewEncoder(), []byte(comment))
	if err != nil || !utf8.Valid(recoveredBytes) {
		return comment
	}
	recovered := string(recoveredBytes)
	if recovered == comment || !isLikelyOracleCommentMojibake(comment, recovered) {
		return comment
	}
	return recovered
}

func isLikelyOracleCommentMojibake(original, recovered string) bool {
	originalRunes := []rune(original)
	recoveredRunes := []rune(recovered)
	if len(recoveredRunes) == 0 || len(recoveredRunes) >= len(originalRunes) {
		return false
	}

	// UTF-8 Chinese characters become two or three GBK-looking runes when the
	// bytes are decoded with the wrong charset. Requiring a shorter recovered
	// value prevents changing ordinary Chinese comments whose GB18030 bytes
	// happen to form valid UTF-8 by coincidence.
	for _, r := range recoveredRunes {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}
