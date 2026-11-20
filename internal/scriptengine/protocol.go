package scriptengine

import "encoding/json"

const (
	frameTypeRun          = "run"
	frameTypeHostRequest  = "host_request"
	frameTypeHostResponse = "host_response"
	frameTypeCancel       = "cancel"
	frameTypeEvent        = "event"
	frameTypeDone         = "done"
)

type workerOutbound struct {
	Type        string          `json:"type"`
	ID          int64           `json:"id,omitempty"`
	Method      string          `json:"method,omitempty"`
	Params      json.RawMessage `json:"params,omitempty"`
	Event       *Event          `json:"event,omitempty"`
	Result      *RunResult      `json:"result,omitempty"`
	ResultValue json.RawMessage `json:"resultValue,omitempty"`
	Error       string          `json:"error,omitempty"`
}

type workerInbound struct {
	Type    string          `json:"type"`
	Request *RunRequest     `json:"request,omitempty"`
	ID      int64           `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

type hostOpenResult struct {
	ReaderID string   `json:"readerId"`
	FileName string   `json:"fileName"`
	Columns  []string `json:"columns,omitempty"`
}

type hostNextResult struct {
	Rows []map[string]any `json:"rows"`
	Done bool             `json:"done"`
}

type hostQueryResult struct {
	Columns   []string         `json:"columns"`
	Rows      []map[string]any `json:"rows"`
	RowCount  int              `json:"rowCount"`
	Truncated bool             `json:"truncated"`
}

type hostExecuteResult struct {
	AffectedRows int64 `json:"affectedRows"`
}

type hostTransactionResult struct {
	TransactionID string `json:"transactionId"`
}
