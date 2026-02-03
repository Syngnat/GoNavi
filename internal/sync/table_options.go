package sync

// TableOptions controls which operations to apply per table, and optional row selection.
// 注意：如未指定 Selected*PKs，则表示“同步全部该类型差异数据”；如指定为空数组，则同样表示全部。
type TableOptions struct {
	Insert bool `json:"insert,omitempty"`
	Update bool `json:"update,omitempty"`
	Delete bool `json:"delete,omitempty"`

	SelectedInsertPKs []string `json:"selectedInsertPks,omitempty"`
	SelectedUpdatePKs []string `json:"selectedUpdatePks,omitempty"`
	SelectedDeletePKs []string `json:"selectedDeletePks,omitempty"`
}
