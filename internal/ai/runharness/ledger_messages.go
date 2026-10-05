package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
)

func cloneMessagePointer(message *Message) *Message {
	if message == nil {
		return nil
	}
	copy := *message
	copy.Attachments = append([]Attachment(nil), message.Attachments...)
	copy.ToolCalls = cloneRaw(message.ToolCalls)
	copy.Images = append([]string(nil), message.Images...)
	copy.Metadata = cloneRaw(message.Metadata)
	return &copy
}

func nullString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func (l *Ledger) appendMessageTx(ctx context.Context, tx *sql.Tx, message Message) error {
	if strings.TrimSpace(message.SessionID) == "" {
		return errors.New("sessionId is required")
	}
	if strings.TrimSpace(message.Role) == "" {
		return errors.New("message role is required")
	}
	if message.ID == "" {
		message.ID = uuid.NewString()
	}
	if message.CreatedAt.IsZero() {
		message.CreatedAt = nowUTC()
	} else {
		message.CreatedAt = message.CreatedAt.UTC()
	}
	if message.Sequence <= 0 {
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE session_id=?`, message.SessionID).Scan(&message.Sequence); err != nil {
			return err
		}
	}
	contentBlob, err := l.seal("messages", message.ID, "content", message.Content)
	if err != nil {
		return err
	}
	metadata := messageMetadata{
		ToolCallID:  message.ToolCallID,
		ToolCalls:   message.ToolCalls,
		Images:      append([]string(nil), message.Images...),
		Attachments: append([]Attachment(nil), message.Attachments...),
		Reasoning:   message.Reasoning,
		Extra:       cloneRaw(message.Metadata),
	}
	metadataBlob, err := l.seal("messages", message.ID, "metadata", metadata)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id,session_id,run_id,sequence,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)`, message.ID, message.SessionID, nullString(message.RunID), message.Sequence, message.Role, contentBlob, metadataBlob, toNano(message.CreatedAt)); err != nil {
		return err
	}
	// Session revision is a projection revision, separate from run revision.
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revision=revision+1,updated_at=? WHERE id=?`, toNano(message.CreatedAt), message.SessionID); err != nil {
		return err
	}
	return nil
}

// messageMetadata keeps fields that are useful to providers/UI adapters out
// of the indexed message columns while still encrypting them at rest.
type messageMetadata struct {
	ToolCallID  string          `json:"toolCallId,omitempty"`
	ToolCalls   json.RawMessage `json:"toolCalls,omitempty"`
	Images      []string        `json:"images,omitempty"`
	Attachments []Attachment    `json:"attachments,omitempty"`
	Reasoning   string          `json:"reasoning,omitempty"`
	Extra       json.RawMessage `json:"extra,omitempty"`
}

func decodeMessageMetadata(l *Ledger, id string, blob []byte) (messageMetadata, error) {
	var metadata messageMetadata
	if len(blob) == 0 {
		return metadata, nil
	}
	if err := l.openJSON("messages", id, "metadata", blob, &metadata); err != nil {
		return messageMetadata{}, err
	}
	return metadata, nil
}

func (l *Ledger) AppendMessage(ctx context.Context, message Message) (Message, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Message{}, err
	}
	if message.ID == "" {
		message.ID = uuid.NewString()
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	if err := l.appendMessageTx(ctx, tx, message); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return l.getMessageDB(ctx, message.ID)
}

func (l *Ledger) getMessageDB(ctx context.Context, messageID string) (Message, error) {
	var id, sessionID, runID, role string
	var sequence, created int64
	var contentBlob, metadataBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE id=?`, messageID).Scan(&id, &sessionID, &runID, &sequence, &role, &contentBlob, &metadataBlob, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, err
	}
	var content string
	if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
		return Message{}, err
	}
	metadata, err := decodeMessageMetadata(l, id, metadataBlob)
	if err != nil {
		return Message{}, err
	}
	return Message{ID: id, SessionID: sessionID, RunID: runID, Sequence: sequence, Role: role, Content: content,
		Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
		ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)}, nil
}

func (l *Ledger) getMessagesTx(ctx context.Context, tx *sql.Tx, sessionID string, afterSequence int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?`, sessionID, afterSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var id, sid, runID, role string
		var sequence, created int64
		var contentBlob, metadataBlob []byte
		if err := rows.Scan(&id, &sid, &runID, &sequence, &role, &contentBlob, &metadataBlob, &created); err != nil {
			return nil, err
		}
		var content string
		if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
			return nil, err
		}
		metadata, err := decodeMessageMetadata(l, id, metadataBlob)
		if err != nil {
			return nil, err
		}
		result = append(result, Message{ID: id, SessionID: sid, RunID: runID, Sequence: sequence, Role: role, Content: content,
			Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
			ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)})
	}
	return result, rows.Err()
}

// getMessagesBeforeSequenceTx loads the exact prefix needed for a session
// branch. Unlike the public paging API it deliberately has no presentation
// limit: a branch must preserve the complete provider context before its safe
// user cursor rather than silently dropping older messages.
func (l *Ledger) getMessagesBeforeSequenceTx(ctx context.Context, tx *sql.Tx, sessionID string, beforeSequence int64) ([]Message, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE session_id=? AND sequence<? ORDER BY sequence`, sessionID, beforeSequence)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var id, sid, runID, role string
		var sequence, created int64
		var contentBlob, metadataBlob []byte
		if err := rows.Scan(&id, &sid, &runID, &sequence, &role, &contentBlob, &metadataBlob, &created); err != nil {
			return nil, err
		}
		var content string
		if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
			return nil, err
		}
		metadata, err := decodeMessageMetadata(l, id, metadataBlob)
		if err != nil {
			return nil, err
		}
		result = append(result, Message{ID: id, SessionID: sid, RunID: runID, Sequence: sequence, Role: role, Content: content,
			Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
			ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)})
	}
	return result, rows.Err()
}

func (l *Ledger) GetMessages(ctx context.Context, sessionID string, afterSequence int64, limit int) ([]Message, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	return l.getMessagesTx(ctx, tx, sessionID, afterSequence, limit)
}

// GetRunMessages returns only the messages that belong to one durable run.
// Query-editor generation requests are intentionally isolated from the chat
// session transcript: several editors can share a session ID without their
// drafts or generated SQL becoming model context for each other.
func (l *Ledger) GetRunMessages(ctx context.Context, runID string, afterSequence int64, limit int) ([]Message, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(runID) == "" {
		return nil, errors.New("runId is required")
	}
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`, runID, afterSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var id, sessionID, storedRunID, role string
		var sequence, created int64
		var contentBlob, metadataBlob []byte
		if err := rows.Scan(&id, &sessionID, &storedRunID, &sequence, &role, &contentBlob, &metadataBlob, &created); err != nil {
			return nil, err
		}
		var content string
		if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
			return nil, err
		}
		metadata, err := decodeMessageMetadata(l, id, metadataBlob)
		if err != nil {
			return nil, err
		}
		result = append(result, Message{ID: id, SessionID: sessionID, RunID: storedRunID, Sequence: sequence, Role: role, Content: content,
			Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
			ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)})
	}
	return result, rows.Err()
}
