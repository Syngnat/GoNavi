package pluginfetch

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Kind identifies where a remote plugin package comes from.
type Kind string

const (
	KindGitHub Kind = "github"
	KindNPM    Kind = "npm"
)

// Spec is a parsed remote plugin reference.
type Spec struct {
	Raw string
	// KindGitHub fills Owner/Repo (Tag optional); KindNPM fills Name (Version optional).
	Kind    Kind
	Owner   string
	Repo    string
	Tag     string
	Name    string
	Version string
	// Asset 与 AssetURL 只在输入是 /releases/download/ 直链时出现：
	// 安装流程跳过 Release 解析，直接下载 AssetURL。
	Asset    string
	AssetURL string
}

var (
	githubOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
	githubRepoPattern  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	// GitHub tag 可以带 _ 和 /（如 release/v1.0），比 semver 宽。
	githubTagPattern = regexp.MustCompile(`^[A-Za-z0-9._+/-]{1,128}$`)
	// npm names are lowercase; segments must not start with a dot or hyphen.
	npmSegmentPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	// Versions and dist-tags share a loose shape; the registry rejects the rest.
	npmVersionPattern = regexp.MustCompile(`^[A-Za-z0-9.+-]{1,64}$`)
)

// Parse classifies a user-typed reference. Anything that does not match the
// github:/npm grammar returns ErrSpecInvalid, which callers treat as a local path.
func Parse(raw string) (Spec, error) {
	trimmed := strings.TrimSpace(raw)
	spec, err := parseSpec(trimmed)
	if err != nil {
		return Spec{}, err
	}
	spec.Raw = trimmed
	return spec, nil
}

func parseSpec(trimmed string) (Spec, error) {
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "github:"):
		return parseGitHubSpec(strings.TrimSpace(trimmed[len("github:"):]))
	case strings.HasPrefix(lower, "https://github.com/"),
		strings.HasPrefix(lower, "http://github.com/"),
		strings.HasPrefix(lower, "https://www.github.com/"),
		strings.HasPrefix(lower, "http://www.github.com/"),
		// 无协议的地址栏粘贴形态也认。
		strings.HasPrefix(lower, "github.com/"),
		strings.HasPrefix(lower, "www.github.com/"):
		return parseGitHubURLSpec(trimmed)
	}
	return parseNPMSpec(trimmed)
}

// parseGitHubURLSpec accepts pasted github.com URLs: repo home, /tree/{tag},
// /releases/tag/{tag}, /releases (latest) and direct /releases/download/ assets.
// http is normalized to https; a missing scheme is assumed https.
func parseGitHubURLSpec(raw string) (Spec, error) {
	normalized := raw
	lower := strings.ToLower(normalized)
	if strings.HasPrefix(lower, "github.com/") {
		normalized = "https://" + normalized
	} else if strings.HasPrefix(lower, "www.github.com/") {
		normalized = "https://" + normalized
	} else if strings.HasPrefix(lower, "http://") {
		normalized = "https://" + normalized[len("http://"):]
	}
	// 去掉查询串与锚点，避免把它们带进下载地址。
	if cut := strings.IndexAny(normalized, "?#"); cut >= 0 {
		normalized = strings.TrimRight(normalized[:cut], "/")
	}
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Host == "" {
		return Spec{}, fmt.Errorf("%w: invalid github url", ErrSpecInvalid)
	}
	host := strings.ToLower(parsed.Host)
	if host != "github.com" && host != "www.github.com" {
		return Spec{}, fmt.Errorf("%w: not a github.com url", ErrSpecInvalid)
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(segments) < 2 {
		return Spec{}, fmt.Errorf("%w: expected owner/repo", ErrSpecInvalid)
	}
	owner, repo := segments[0], strings.TrimSuffix(segments[1], ".git")
	if !githubOwnerPattern.MatchString(owner) || !githubRepoPattern.MatchString(repo) {
		return Spec{}, fmt.Errorf("%w: invalid owner or repository name", ErrSpecInvalid)
	}
	spec := Spec{Kind: KindGitHub, Owner: owner, Repo: repo}
	rest := segments[2:]
	switch {
	case len(rest) == 0:
		return spec, nil
	case rest[0] == "tree" && len(rest) >= 2:
		spec.Tag = strings.Join(rest[1:], "/")
		if spec.Tag == "" || !githubTagPattern.MatchString(spec.Tag) {
			return Spec{}, fmt.Errorf("%w: invalid release tag", ErrSpecInvalid)
		}
		return spec, nil
	case rest[0] != "releases":
		return Spec{}, fmt.Errorf("%w: unsupported github url path", ErrSpecInvalid)
	case len(rest) == 1 || (len(rest) == 2 && rest[1] == "latest"):
		return spec, nil // /releases、/releases/latest → 最新 Release
	case rest[1] == "tag" && len(rest) >= 3:
		spec.Tag = strings.Join(rest[2:], "/")
		if spec.Tag == "" || !githubTagPattern.MatchString(spec.Tag) {
			return Spec{}, fmt.Errorf("%w: invalid release tag", ErrSpecInvalid)
		}
		return spec, nil
	case rest[1] == "download" && len(rest) >= 4:
		spec.Tag = rest[2]
		spec.Asset = strings.Join(rest[3:], "/")
		if spec.Tag == "" || spec.Asset == "" {
			return Spec{}, fmt.Errorf("%w: incomplete release asset url", ErrSpecInvalid)
		}
		spec.AssetURL = normalized
		if err := ValidateDownloadURL(spec.AssetURL); err != nil {
			return Spec{}, err
		}
		return spec, nil
	default:
		return Spec{}, fmt.Errorf("%w: unsupported github url path", ErrSpecInvalid)
	}
}

func parseGitHubSpec(rest string) (Spec, error) {
	if rest == "" {
		return Spec{}, fmt.Errorf("%w: empty repository", ErrSpecInvalid)
	}
	repoPart, tag := rest, ""
	if at := strings.Index(rest, "@"); at >= 0 {
		repoPart, tag = rest[:at], strings.TrimSpace(rest[at+1:])
		if tag == "" || !githubTagPattern.MatchString(tag) {
			return Spec{}, fmt.Errorf("%w: invalid release tag %q", ErrSpecInvalid, tag)
		}
	}
	owner, repo, ok := strings.Cut(repoPart, "/")
	if !ok || owner == "" || repo == "" || strings.Contains(repo, "/") {
		return Spec{}, fmt.Errorf("%w: expected owner/repo", ErrSpecInvalid)
	}
	if !githubOwnerPattern.MatchString(owner) || !githubRepoPattern.MatchString(repo) {
		return Spec{}, fmt.Errorf("%w: invalid owner or repository name", ErrSpecInvalid)
	}
	return Spec{Kind: KindGitHub, Owner: owner, Repo: repo, Tag: tag}, nil
}

func parseNPMSpec(raw string) (Spec, error) {
	// 斜杠只允许出现在 scoped 名的那一处；反斜杠/冒号/空格意味着这是本地路径。
	if raw == "" || strings.ContainsAny(raw, "\\: ") {
		return Spec{}, fmt.Errorf("%w: not an npm package name", ErrSpecInvalid)
	}
	name, version := raw, ""
	if strings.HasPrefix(raw, "@") {
		scope, rest, ok := strings.Cut(raw[1:], "/")
		if !ok || scope == "" || rest == "" {
			return Spec{}, fmt.Errorf("%w: scoped packages need a name after the slash", ErrSpecInvalid)
		}
		if at := strings.Index(rest, "@"); at >= 0 {
			name, version = "@"+scope+"/"+rest[:at], strings.TrimSpace(rest[at+1:])
		}
	} else if at := strings.Index(raw, "@"); at >= 0 {
		name, version = raw[:at], strings.TrimSpace(raw[at+1:])
	}
	if version != "" && !npmVersionPattern.MatchString(version) {
		return Spec{}, fmt.Errorf("%w: invalid version %q", ErrSpecInvalid, version)
	}
	if err := validateNPMName(name); err != nil {
		return Spec{}, err
	}
	return Spec{Kind: KindNPM, Name: name, Version: version}, nil
}

func validateNPMName(name string) error {
	if name == "" || len(name) > 214 {
		return fmt.Errorf("%w: invalid package name", ErrSpecInvalid)
	}
	scoped := strings.HasPrefix(name, "@")
	segments := strings.Split(strings.TrimPrefix(name, "@"), "/")
	if scoped && len(segments) != 2 {
		return fmt.Errorf("%w: scoped packages need scope and name", ErrSpecInvalid)
	}
	if !scoped && len(segments) != 1 {
		return fmt.Errorf("%w: unscoped names must not contain a slash", ErrSpecInvalid)
	}
	for _, segment := range segments {
		if !npmSegmentPattern.MatchString(segment) {
			return fmt.Errorf("%w: invalid package name segment %q", ErrSpecInvalid, segment)
		}
	}
	return nil
}
