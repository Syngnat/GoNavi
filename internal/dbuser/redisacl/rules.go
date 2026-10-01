package redisacl

import (
	"regexp"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// userRules 是从 ACL LIST 一行解析出的用户规则。
type userRules struct {
	name      string
	enabled   bool
	noPass    bool
	passwords int
	keys      []string
	channels  []string
	commands  []string
	selectors []string
}

// tokenizeACL 按空格切分规则，括号内的 selector 作为一个整体。
func tokenizeACL(line string) []string {
	var tokens []string
	var current strings.Builder
	depth := 0
	flush := func() {
		if current.Len() > 0 {
			tokens = append(tokens, current.String())
			current.Reset()
		}
	}
	for _, r := range line {
		switch {
		case r == '(':
			depth++
			current.WriteRune(r)
		case r == ')':
			depth--
			current.WriteRune(r)
		case r == ' ' && depth == 0:
			flush()
		default:
			current.WriteRune(r)
		}
	}
	flush()
	return tokens
}

// parseACLLine 解析 "user <name> on #hash ~k* &c* +@all (~x +get)"。
func parseACLLine(line string) (userRules, bool) {
	tokens := tokenizeACL(strings.TrimSpace(line))
	if len(tokens) < 2 || tokens[0] != "user" {
		return userRules{}, false
	}
	rules := userRules{name: tokens[1]}
	for _, token := range tokens[2:] {
		switch {
		case token == "on":
			rules.enabled = true
		case token == "off":
			rules.enabled = false
		case token == "nopass":
			rules.noPass = true
		case strings.HasPrefix(token, "#") || strings.HasPrefix(token, ">"):
			rules.passwords++
		case token == "allkeys":
			rules.keys = append(rules.keys, "~*")
		case strings.HasPrefix(token, "~") || strings.HasPrefix(token, "%"):
			rules.keys = append(rules.keys, token)
		case token == "allchannels":
			rules.channels = append(rules.channels, "&*")
		case strings.HasPrefix(token, "&"):
			rules.channels = append(rules.channels, token)
		case token == "allcommands":
			rules.commands = append(rules.commands, "+@all")
		case token == "nocommands":
			rules.commands = append(rules.commands, "-@all")
		case strings.HasPrefix(token, "+") || strings.HasPrefix(token, "-"):
			rules.commands = append(rules.commands, token)
		case strings.HasPrefix(token, "(") && strings.HasSuffix(token, ")"):
			rules.selectors = append(rules.selectors, token)
		}
	}
	return rules, true
}

var (
	keyRulePattern     = regexp.MustCompile(`^(~|%R~|%W~|%RW~)\S*$`)
	channelRulePattern = regexp.MustCompile(`^&\S*$`)
	commandRulePattern = regexp.MustCompile(`^[+-](@?[A-Za-z0-9_.:-]+(\|[A-Za-z0-9_.:-]+)?)$`)
)

// validateRules 校验规则片段，拒绝空白与未知前缀，防止借规则注入 on/nopass 等开关。
func validateRules(items []string, pattern *regexp.Regexp, option string) error {
	for _, item := range items {
		if !pattern.MatchString(item) {
			return dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", option)
		}
	}
	return nil
}

func validateSelectors(items []string) error {
	for _, item := range items {
		if !strings.HasPrefix(item, "(") || !strings.HasSuffix(item, ")") || strings.Count(item, "(") != 1 || strings.Count(item, ")") != 1 {
			return dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", dbuser.OptACLSelectors)
		}
		for rule := range strings.FieldsSeq(strings.Trim(item, "()")) {
			if !(keyRulePattern.MatchString(rule) || channelRulePattern.MatchString(rule) || commandRulePattern.MatchString(rule)) {
				return dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", dbuser.OptACLSelectors)
			}
		}
	}
	return nil
}
