package mcpserver

import "GoNavi-Wails/internal/scriptlib"

type getScriptLibraryArgs struct {
	Query string `json:"query,omitempty" jsonschema:"可选关键字，按脚本 ID、名称、描述、连接别名或输入别名过滤"`
	Limit int    `json:"limit,omitempty" jsonschema:"最多返回多少个脚本，默认 200，最大 1000；完整源码请用 get_script 读取"`
}

type scriptIDArgs struct {
	ScriptID string `json:"scriptId" jsonschema:"get_script_library 返回的脚本 ID"`
}

type scriptConnectionBindingArgs struct {
	Alias        string `json:"alias" jsonschema:"脚本内 gonavi.db 使用的连接别名，例如 prod"`
	ConnectionID string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	Database     string `json:"database,omitempty" jsonschema:"可选数据库或 Schema；为空时使用连接默认库"`
}

type scriptInputBindingArgs struct {
	Alias     string `json:"alias" jsonschema:"脚本内 gonavi.files.open 使用的输入别名"`
	Path      string `json:"path,omitempty" jsonschema:"桌面端本地 CSV、JSON 或 XLSX 文件路径；与 reference 二选一"`
	Reference string `json:"reference,omitempty" jsonschema:"Web 上传文件引用；桌面端通常使用 path"`
	Name      string `json:"name,omitempty" jsonschema:"可选显示文件名"`
	SheetName string `json:"sheetName,omitempty" jsonschema:"XLSX 工作表名称；为空时读取第一个工作表"`
	Encoding  string `json:"encoding,omitempty" jsonschema:"文本编码，例如 utf-8 或 gbk"`
	Delimiter string `json:"delimiter,omitempty" jsonschema:"CSV 分隔符；为空时自动识别"`
	HeaderRow int    `json:"headerRow,omitempty" jsonschema:"表头所在行，默认 1"`
}

type saveScriptArgs struct {
	ID               string                        `json:"id,omitempty" jsonschema:"可选脚本 ID；为空时创建新脚本。更新时必须传 revision"`
	Name             string                        `json:"name" jsonschema:"脚本名称"`
	Description      string                        `json:"description,omitempty" jsonschema:"脚本说明"`
	Code             string                        `json:"code" jsonschema:"JavaScript 源码，使用 gonavi.db / gonavi.files / gonavi.output 等宿主 API"`
	Visibility       string                        `json:"visibility,omitempty" jsonschema:"private 或 shared；默认 private"`
	FolderID         string                        `json:"folderId,omitempty" jsonschema:"可选脚本文件夹 ID"`
	Connections      []scriptConnectionBindingArgs `json:"connections,omitempty" jsonschema:"脚本连接别名绑定"`
	Inputs           []scriptInputBindingArgs      `json:"inputs,omitempty" jsonschema:"脚本输入文件别名绑定"`
	AllowWrite       bool                          `json:"allowWrite,omitempty" jsonschema:"脚本保存的写入默认值；运行脚本时仍需再次显式传 allowWrite"`
	BatchSize        int                           `json:"batchSize,omitempty" jsonschema:"可选批大小，默认 500，最大 5000"`
	INListLimit      int                           `json:"inListLimit,omitempty" jsonschema:"可选 IN 列表分片大小，默认 1000，最大 1000"`
	TimeoutMs        int64                         `json:"timeoutMs,omitempty" jsonschema:"可选运行超时毫秒数；零值使用运行时默认值"`
	MaxDBCalls       int                           `json:"maxDbCalls,omitempty" jsonschema:"可选数据库调用次数上限；零值使用运行时默认值"`
	MaxOutputRows    int                           `json:"maxOutputRows,omitempty" jsonschema:"可选累计输出行数上限；零值使用运行时默认值"`
	MemoryLimitBytes int64                         `json:"memoryLimitBytes,omitempty" jsonschema:"可选脚本工作进程内存上限字节数；零值使用运行时默认值"`
	Revision         uint64                        `json:"revision,omitempty" jsonschema:"更新已有脚本时必须传入 get_script 返回的 revision；创建时保持 0"`
}

type scriptInputSheetsArgs struct {
	Path      string `json:"path,omitempty" jsonschema:"桌面端 CSV、JSON 或 XLSX 文件路径；与 reference 二选一"`
	Reference string `json:"reference,omitempty" jsonschema:"Web 上传文件引用"`
}

type scriptInputSheetsResult struct {
	Sheets []string `json:"sheets"`
}

type prepareScriptWriteArgs struct {
	ScriptID         string                        `json:"scriptId,omitempty" jsonschema:"可选已保存脚本 ID；与 script 至少传一个。传 script 时作为源码覆盖"`
	Script           string                        `json:"script,omitempty" jsonschema:"可选 JavaScript 源码；与 scriptId 至少传一个。适合 AI 临时生成脚本"`
	Title            string                        `json:"title,omitempty" jsonschema:"可选运行标题"`
	Connections      []scriptConnectionBindingArgs `json:"connections,omitempty" jsonschema:"脚本连接别名绑定；会覆盖脚本库中同别名绑定"`
	Inputs           []scriptInputBindingArgs      `json:"inputs,omitempty" jsonschema:"脚本输入文件别名绑定；会覆盖脚本库中同别名绑定"`
	AllowWrite       bool                          `json:"allowWrite,omitempty" jsonschema:"是否允许脚本执行 db.execute / 事务写。受 AI 安全控制约束"`
	BatchSize        int                           `json:"batchSize,omitempty" jsonschema:"可选批大小"`
	INListLimit      int                           `json:"inListLimit,omitempty" jsonschema:"可选 IN 列表分片大小"`
	TimeoutMs        int64                         `json:"timeoutMs,omitempty" jsonschema:"可选运行超时毫秒数"`
	MaxDBCalls       int                           `json:"maxDbCalls,omitempty" jsonschema:"可选数据库调用次数上限"`
	MaxOutputRows    int                           `json:"maxOutputRows,omitempty" jsonschema:"可选累计输出行数上限"`
	MemoryLimitBytes int64                         `json:"memoryLimitBytes,omitempty" jsonschema:"可选脚本工作进程内存上限字节数"`
}

type runScriptArgs struct {
	ScriptID           string                        `json:"scriptId,omitempty" jsonschema:"可选已保存脚本 ID；与 script 至少传一个。传 script 时作为源码覆盖"`
	Script             string                        `json:"script,omitempty" jsonschema:"可选 JavaScript 源码；与 scriptId 至少传一个。适合 AI 临时生成脚本"`
	Title              string                        `json:"title,omitempty" jsonschema:"可选运行标题"`
	Connections        []scriptConnectionBindingArgs `json:"connections,omitempty" jsonschema:"脚本连接别名绑定；会覆盖脚本库中同别名绑定"`
	Inputs             []scriptInputBindingArgs      `json:"inputs,omitempty" jsonschema:"脚本输入文件别名绑定；会覆盖脚本库中同别名绑定"`
	AllowWrite         bool                          `json:"allowWrite,omitempty" jsonschema:"是否允许脚本执行 db.execute / 事务写。只读安全等级会拒绝；读写等级禁止 DDL；完全等级才允许 DDL"`
	BatchSize          int                           `json:"batchSize,omitempty" jsonschema:"可选批大小"`
	INListLimit        int                           `json:"inListLimit,omitempty" jsonschema:"可选 IN 列表分片大小"`
	TimeoutMs          int64                         `json:"timeoutMs,omitempty" jsonschema:"可选运行超时毫秒数"`
	MaxDBCalls         int                           `json:"maxDbCalls,omitempty" jsonschema:"可选数据库调用次数上限"`
	MaxOutputRows      int                           `json:"maxOutputRows,omitempty" jsonschema:"可选累计输出行数上限"`
	MemoryLimitBytes   int64                         `json:"memoryLimitBytes,omitempty" jsonschema:"可选脚本工作进程内存上限字节数"`
	WriteApprovalToken string                        `json:"writeApprovalToken,omitempty" jsonschema:"生产库写入时由 prepare_script_write 返回的一次性 token；必须用完全相同的脚本、连接、输入和限制参数运行"`
	WaitSeconds        *int                          `json:"waitSeconds,omitempty" jsonschema:"等待终态秒数。默认 15，最大 60；传 0 立即返回。超时后用 get_script_run 轮询"`
}

type scriptRunIDArgs struct {
	RunID string `json:"runId" jsonschema:"run_script 返回的 runId"`
}

type scriptOutputArgs struct {
	RunID       string `json:"runId" jsonschema:"run_script 返回的 runId"`
	OutputIndex int    `json:"outputIndex" jsonschema:"get_script_run 返回的 outputs[].index，从 0 开始"`
	Page        int    `json:"page,omitempty" jsonschema:"页码，从 1 开始，默认 1"`
	PageSize    int    `json:"pageSize,omitempty" jsonschema:"每页行数，默认 50，最大 200"`
}

type scriptSummaryConnection struct {
	Alias        string `json:"alias"`
	ConnectionID string `json:"connectionId,omitempty"`
	Database     string `json:"database,omitempty"`
}

type scriptSummaryInput struct {
	Alias     string `json:"alias"`
	Name      string `json:"name,omitempty"`
	SheetName string `json:"sheetName,omitempty"`
}

type scriptSummary struct {
	ID          string                    `json:"id"`
	Name        string                    `json:"name"`
	Description string                    `json:"description,omitempty"`
	Visibility  scriptlib.Visibility      `json:"visibility"`
	FolderID    string                    `json:"folderId,omitempty"`
	AllowWrite  bool                      `json:"allowWrite"`
	Connections []scriptSummaryConnection `json:"connections"`
	Inputs      []scriptSummaryInput      `json:"inputs"`
	CanEdit     bool                      `json:"canEdit"`
	CanShare    bool                      `json:"canShare"`
	Revision    uint64                    `json:"revision"`
	UpdatedAt   int64                     `json:"updatedAt"`
}

type getScriptLibraryResult struct {
	Owner      string             `json:"owner"`
	Scripts    []scriptSummary    `json:"scripts"`
	Folders    []scriptlib.Folder `json:"folders"`
	CanWrite   bool               `json:"canWrite"`
	CanShare   bool               `json:"canShare"`
	SharedOnly bool               `json:"sharedOnly"`
	ReadOnly   bool               `json:"readOnly"`
	Total      int                `json:"total"`
	Truncated  bool               `json:"truncated,omitempty"`
}
