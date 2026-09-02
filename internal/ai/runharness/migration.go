package runharness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrMigrationConflict = errors.New("legacy agent session migration conflict")
	ErrMigrationCorrupt  = errors.New("legacy agent session is corrupt")
	ErrMigrationReadOnly = errors.New("legacy agent session could not be made read-only")
)

// LegacyMigrationResult reports the work performed by a migration pass. The
// source files themselves are never rewritten; successful sources are only
// chmod'ed to 0400 after the SQLite transaction commits.
type LegacyMigrationResult struct {
	Scanned  int `json:"scanned"`
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
}

type legacySessionSource struct {
	path             string
	id               string
	title            string
	sha256           string
	updatedAt        time.Time
	messages         []Message
	providerKey      string
	providerState    json.RawMessage
	providerMessages json.RawMessage
}

// legacyProviderEnvelope is stored as one encrypted migration-record payload.
// Keeping the provider key, opaque state, and provider message projection in
// the same sealed value prevents any sensitive field from being left in the
// SQLite file as a plain-text column.
type legacyProviderEnvelope struct {
	SessionID        string          `json:"sessionId"`
	ProviderKey      string          `json:"providerKey,omitempty"`
	ProviderState    json.RawMessage `json:"providerState,omitempty"`
	ProviderMessages json.RawMessage `json:"providerMessages,omitempty"`
}

// MigrateLegacySessions imports the old <data-root>/sessions/*.json format.
// All candidate files are read and validated before a write transaction is
// opened. A single transaction then inserts every new session, message, and
// migration record, so malformed input or any SQL failure leaves no partial
// import behind. Re-running with the same absolute source path and SHA-256 is
// idempotent; changing a previously imported source is a conflict.
func (l *Ledger) MigrateLegacySessions(ctx context.Context, sessionsDir string) (LegacyMigrationResult, error) {
	result := LegacyMigrationResult{}
	if ctx == nil {
		ctx = context.Background()
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return result, err
	}
	dir := strings.TrimSpace(sessionsDir)
	if dir == "" {
		return result, errors.New("legacy sessions directory is empty")
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return result, fmt.Errorf("resolve legacy sessions directory: %w", err)
	}
	entries, err := os.ReadDir(absDir)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("read legacy sessions directory: %w", err)
	}
	// os.ReadDir(string) is sorted by filename, but sort explicitly so the
	// import order remains deterministic if the source changes to another
	// directory implementation in the future.
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	sources := make([]legacySessionSource, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		path := filepath.Join(absDir, entry.Name())
		info, statErr := os.Lstat(path)
		if statErr != nil {
			return result, fmt.Errorf("%w: stat %s: %v", ErrMigrationCorrupt, path, statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return result, fmt.Errorf("%w: %s is not a regular file", ErrMigrationCorrupt, path)
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return result, fmt.Errorf("%w: read %s: %v", ErrMigrationCorrupt, path, readErr)
		}
		result.Scanned++
		source, parseErr := parseLegacySession(path, data, info.ModTime())
		if parseErr != nil {
			return result, parseErr
		}
		source.path = path
		source.sha256 = hashBytes(data)
		sources = append(sources, source)
	}
	if len(sources) == 0 {
		return result, nil
	}

	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	imported := 0
	skipped := 0
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, err
		}
		existingHash, found, lookupErr := legacyMigrationRecordTx(ctx, tx, source.path)
		if lookupErr != nil {
			return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, lookupErr
		}
		if found {
			if !strings.EqualFold(existingHash, source.sha256) {
				return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, fmt.Errorf("%w: source %s changed after migration", ErrMigrationConflict, source.path)
			}
			skipped++
			continue
		}

		var existingSessionID string
		sessionErr := tx.QueryRowContext(ctx, `SELECT id FROM sessions WHERE id=?`, source.id).Scan(&existingSessionID)
		switch {
		case sessionErr == nil:
			return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, fmt.Errorf("%w: session %s already exists", ErrMigrationConflict, source.id)
		case !errors.Is(sessionErr, sql.ErrNoRows):
			return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, sessionErr
		}
		if err := l.insertLegacySessionTx(ctx, tx, source); err != nil {
			return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, err
		}
		providerPayload, sealErr := l.sealLegacyProvider(source)
		if sealErr != nil {
			return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, sealErr
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO migration_records(source_path,source_sha256,migrated_at,payload) VALUES(?,?,?,?)`, source.path, source.sha256, toNano(nowUTC()), providerPayload); err != nil {
			return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, fmt.Errorf("record legacy migration %s: %w", source.path, err)
		}
		imported++
	}
	if err := tx.Commit(); err != nil {
		return LegacyMigrationResult{Scanned: result.Scanned, Skipped: skipped}, err
	}
	result.Imported = imported
	result.Skipped = skipped

	// chmod is intentionally the only source-file mutation. Do it after the
	// commit so a parse/SQL failure never leaves a misleading read-only marker.
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if err := os.Chmod(source.path, 0o400); err != nil {
			return result, fmt.Errorf("%w: %s: %v", ErrMigrationReadOnly, source.path, err)
		}
	}
	return result, nil
}

func legacyMigrationRecordTx(ctx context.Context, tx *sql.Tx, path string) (hash string, found bool, err error) {
	err = tx.QueryRowContext(ctx, `SELECT source_sha256 FROM migration_records WHERE source_path=?`, path).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return hash, true, nil
}

func parseLegacySession(path string, data []byte, modTime time.Time) (legacySessionSource, error) {
	var source legacySessionSource
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return source, fmt.Errorf("%w: %s is empty", ErrMigrationCorrupt, path)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		if err == nil {
			err = errors.New("top-level value is not an object")
		}
		return source, fmt.Errorf("%w: parse %s: %v", ErrMigrationCorrupt, path, err)
	}
	id, err := legacyStringField(fields, "id", "sessionId", "session_id")
	if err != nil {
		return source, legacyFieldError(path, "id", err)
	}
	if strings.TrimSpace(id) == "" {
		id = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return source, fmt.Errorf("%w: %s has no session id", ErrMigrationCorrupt, path)
	}
	title, err := legacyStringField(fields, "title")
	if err != nil {
		return source, legacyFieldError(path, "title", err)
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Imported session"
	}
	updatedAt, err := legacyTimeField(fields, "updatedAt", "updated_at", "timestamp", "createdAt", "created_at")
	if err != nil {
		return source, legacyFieldError(path, "updatedAt", err)
	}
	if updatedAt.IsZero() {
		updatedAt = modTime.UTC()
	}
	if updatedAt.IsZero() {
		updatedAt = nowUTC()
	}

	messageRaw := firstLegacyField(fields, "messages")
	messages, err := parseLegacyMessages(path, id, messageRaw, updatedAt)
	if err != nil {
		return source, err
	}
	providerKey, err := legacyStringField(fields, "providerKey", "provider_key")
	if err != nil {
		return source, legacyFieldError(path, "providerKey", err)
	}
	providerState, err := legacyJSONField(fields, "providerState", "provider_state")
	if err != nil {
		return source, legacyFieldError(path, "providerState", err)
	}
	providerMessages, err := legacyJSONField(fields, "providerMessages", "provider_messages")
	if err != nil {
		return source, legacyFieldError(path, "providerMessages", err)
	}
	return legacySessionSource{
		id:               id,
		title:            title,
		updatedAt:        updatedAt,
		messages:         messages,
		providerKey:      strings.TrimSpace(providerKey),
		providerState:    providerState,
		providerMessages: providerMessages,
	}, nil
}

func parseLegacyMessages(path, sessionID string, raw json.RawMessage, fallback time.Time) ([]Message, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil, fmt.Errorf("%w: parse messages in %s: %v", ErrMigrationCorrupt, path, err)
	}
	messages := make([]Message, 0, len(entries))
	seenIDs := make(map[string]struct{}, len(entries))
	for index, entry := range entries {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(entry, &fields); err != nil || fields == nil {
			if err == nil {
				err = errors.New("message is not an object")
			}
			return nil, fmt.Errorf("%w: message %d in %s: %v", ErrMigrationCorrupt, index, path, err)
		}
		id, err := legacyStringField(fields, "id", "messageId", "message_id")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].id", index), err)
		}
		id = strings.TrimSpace(id)
		if id == "" {
			// Stable IDs keep a retry after a transaction failure deterministic,
			// while preserving supplied legacy IDs verbatim for UI references.
			id = uuid.NewSHA1(uuid.Nil, []byte(path+"\x00"+strconv.Itoa(index))).String()
		}
		if _, duplicate := seenIDs[id]; duplicate {
			return nil, fmt.Errorf("%w: duplicate message id %q in %s", ErrMigrationConflict, id, path)
		}
		seenIDs[id] = struct{}{}
		role, err := legacyStringField(fields, "role")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].role", index), err)
		}
		role = strings.TrimSpace(role)
		if role == "" {
			return nil, fmt.Errorf("%w: message %d in %s has no role", ErrMigrationCorrupt, index, path)
		}
		content, err := legacyContentField(fields, "content", "text")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].content", index), err)
		}
		createdAt, err := legacyTimeField(fields, "timestamp", "createdAt", "created_at", "time")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].timestamp", index), err)
		}
		if createdAt.IsZero() {
			createdAt = fallback
		}
		images, err := legacyStringSliceField(fields, "images")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].images", index), err)
		}
		attachments, err := legacyAttachmentsField(fields)
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].attachments", index), err)
		}
		reasoning, err := legacyStringField(fields, "reasoning_content", "reasoningContent", "reasoning", "thinking")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].reasoning", index), err)
		}
		toolCallID, err := legacyStringField(fields, "tool_call_id", "toolCallId", "toolCallID")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].toolCallId", index), err)
		}
		toolCalls, err := legacyJSONArrayField(fields, "tool_calls", "toolCalls")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].toolCalls", index), err)
		}
		metadata, err := legacyJSONField(fields, "metadata")
		if err != nil {
			return nil, legacyFieldError(path, fmt.Sprintf("messages[%d].metadata", index), err)
		}
		messages = append(messages, Message{ID: id, SessionID: sessionID, Sequence: int64(index + 1), Role: role,
			Content: content, Images: images, Attachments: attachments, Reasoning: reasoning,
			ToolCallID: strings.TrimSpace(toolCallID), ToolCalls: toolCalls, Metadata: metadata, CreatedAt: createdAt.UTC()})
	}
	return messages, nil
}

func (l *Ledger) insertLegacySessionTx(ctx context.Context, tx *sql.Tx, source legacySessionSource) error {
	now := source.updatedAt.UTC()
	if now.IsZero() {
		now = nowUTC()
	}
	created := now
	for _, message := range source.messages {
		if !message.CreatedAt.IsZero() && message.CreatedAt.Before(created) {
			created = message.CreatedAt.UTC()
		}
	}
	titleBlob, err := l.seal("sessions", source.id, "title", source.title)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,revision,generation,title,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, source.id, 1, 1, titleBlob, 0, toNano(created), toNano(now)); err != nil {
		return fmt.Errorf("insert legacy session %s: %w", source.id, err)
	}
	for index, message := range source.messages {
		message.SessionID = source.id
		message.RunID = ""
		message.Sequence = int64(index + 1)
		if message.CreatedAt.IsZero() {
			message.CreatedAt = now
		}
		if err := l.appendMessageTx(ctx, tx, message); err != nil {
			return fmt.Errorf("insert legacy message %s[%d]: %w", source.id, index, err)
		}
	}
	// appendMessageTx increments the projection revision and updates the
	// timestamp for each message. Restore the source's session-level timestamp
	// after import while retaining one revision per imported message.
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revision=?,updated_at=? WHERE id=?`, int64(1+len(source.messages)), toNano(now), source.id); err != nil {
		return err
	}
	return nil
}

func (l *Ledger) sealLegacyProvider(source legacySessionSource) ([]byte, error) {
	if source.providerKey == "" && len(bytes.TrimSpace(source.providerState)) == 0 && len(bytes.TrimSpace(source.providerMessages)) == 0 {
		return nil, nil
	}
	payload, err := json.Marshal(legacyProviderEnvelope{SessionID: source.id, ProviderKey: source.providerKey,
		ProviderState: cloneRaw(source.providerState), ProviderMessages: cloneRaw(source.providerMessages)})
	if err != nil {
		return nil, err
	}
	return l.sealRaw("migration_records", source.path, "provider_state", payload)
}

func firstLegacyField(fields map[string]json.RawMessage, names ...string) json.RawMessage {
	for _, name := range names {
		if value, ok := fields[name]; ok {
			return value
		}
	}
	return nil
}

func legacyStringField(fields map[string]json.RawMessage, names ...string) (string, error) {
	raw := firstLegacyField(fields, names...)
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	return value, nil
}

func legacyContentField(fields map[string]json.RawMessage, names ...string) (string, error) {
	raw := firstLegacyField(fields, names...)
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err == nil {
		return value, nil
	}
	var structured any
	if err := json.Unmarshal(raw, &structured); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(structured)
	return string(encoded), err
}

func legacyJSONField(fields map[string]json.RawMessage, names ...string) (json.RawMessage, error) {
	raw := firstLegacyField(fields, names...)
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	if !json.Valid(raw) {
		return nil, errors.New("value is not valid JSON")
	}
	return cloneRaw(raw), nil
}

func legacyJSONArrayField(fields map[string]json.RawMessage, names ...string) (json.RawMessage, error) {
	raw, err := legacyJSONField(fields, names...)
	if err != nil || len(raw) == 0 {
		return raw, err
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	return raw, nil
}

func legacyStringSliceField(fields map[string]json.RawMessage, names ...string) ([]string, error) {
	raw := firstLegacyField(fields, names...)
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	return values, nil
}

func legacyAttachmentsField(fields map[string]json.RawMessage) ([]Attachment, error) {
	raw := firstLegacyField(fields, "attachments")
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, err
	}
	attachments := make([]Attachment, 0, len(entries))
	for _, entry := range entries {
		if entry == nil {
			return nil, errors.New("attachment is not an object")
		}
		name, err := legacyStringField(entry, "name", "fileName", "filename")
		if err != nil {
			return nil, err
		}
		mediaType, err := legacyStringField(entry, "mediaType", "mimeType", "mime_type", "type")
		if err != nil {
			return nil, err
		}
		data, err := legacyStringField(entry, "data", "dataUrl", "dataURL", "text", "content")
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, Attachment{Name: name, MediaType: mediaType, Data: data})
	}
	return attachments, nil
}

func legacyTimeField(fields map[string]json.RawMessage, names ...string) (time.Time, error) {
	raw := firstLegacyField(fields, names...)
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return time.Time{}, nil
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return time.Time{}, err
	}
	switch typed := value.(type) {
	case string:
		if parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(typed)); err == nil {
			return parsed.UTC(), nil
		}
		number, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return time.Time{}, err
		}
		return legacyUnixTime(number), nil
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return time.Time{}, err
		}
		return legacyUnixTime(number), nil
	default:
		return time.Time{}, fmt.Errorf("unsupported timestamp type %T", value)
	}
}

func legacyUnixTime(value float64) time.Time {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return time.Time{}
	}
	// Legacy browser timestamps are milliseconds. Accept seconds, microseconds,
	// and nanoseconds as well because older integrations used all four units.
	var seconds float64
	switch {
	case value >= 1e17:
		seconds = value / 1e9
	case value >= 1e14:
		seconds = value / 1e6
	case value >= 1e11:
		seconds = value / 1e3
	default:
		seconds = value
	}
	whole, fraction := math.Modf(seconds)
	if whole > float64(math.MaxInt64) || whole < float64(math.MinInt64) {
		return time.Time{}
	}
	return time.Unix(int64(whole), int64(fraction*1e9)).UTC()
}

func legacyFieldError(path, field string, err error) error {
	return fmt.Errorf("%w: %s field %s: %v", ErrMigrationCorrupt, path, field, err)
}
