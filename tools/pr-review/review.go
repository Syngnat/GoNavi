package main

// 本包是 PR 评审机器人的纯逻辑：只看 diff，不执行 PR 里的代码。

const (
	severityWarning = "warning"
	severityError   = "error"

	reviewMarker = "<!-- gonavi-pr-review -->"
	maxFileLines = 800
)

// FileChange 是 GitHub pulls files 接口里和评审有关的字段。
type FileChange struct {
	Filename  string `json:"filename"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Patch     string `json:"patch"`
}

// Finding 是一条可回复到 PR 的意见。Line 为 0 时只出现在汇总，不挂行内评论。
type Finding struct {
	Path     string
	Line     int
	Severity string
	Rule     string
	Message  string
}

func (f Finding) blocks() bool {
	return f.Severity == severityError
}
