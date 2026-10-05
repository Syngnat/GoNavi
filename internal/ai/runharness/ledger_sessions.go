package runharness

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

func (l *Ledger) CreateSession(ctx context.Context, request CreateSessionRequest) (SessionProjection, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	id := strings.TrimSpace(request.SessionID)
	if id == "" {
		id = uuid.NewString()
	}
	now := nowUTC()
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()
	if existing, err := l.getSessionTx(ctx, tx, id, false); err == nil {
		return existing, nil
	} else if !errors.Is(err, ErrNotFound) {
		return SessionProjection{}, err
	}
	titleBlob, err := l.seal("sessions", id, "title", strings.TrimSpace(request.Title))
	if err != nil {
		return SessionProjection{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,revision,generation,title,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, 1, 1, titleBlob, 0, toNano(now), toNano(now)); err != nil {
		return SessionProjection{}, err
	}
	if err := tx.Commit(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, id, false)
}

// CreateSessionBranch creates a new immutable transcript branch from a user
// message in an existing session. The source transcript remains unchanged;
// only messages strictly before the cursor are copied, so the caller's next
// input can replace or retry that user turn without rewriting completed work.
// A stable caller-provided SessionID makes retrying the same submission
// idempotent.
func (l *Ledger) CreateSessionBranch(ctx context.Context, request CreateSessionBranchRequest) (SessionProjection, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.SourceSessionID = strings.TrimSpace(request.SourceSessionID)
	request.BranchFromMessageID = strings.TrimSpace(request.BranchFromMessageID)
	if request.SessionID == "" || request.SourceSessionID == "" || request.BranchFromMessageID == "" {
		return SessionProjection{}, errors.New("sessionId, sourceSessionId, and branchFromMessageId are required")
	}
	if request.SessionID == request.SourceSessionID {
		return SessionProjection{}, ErrBranchConflict
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()

	// Idempotent replays must return precisely the branch created by the first
	// request. They must not create a second branch merely because the source
	// session has advanced after the original edit/retry was accepted.
	if existing, existingErr := l.getSessionTx(ctx, tx, request.SessionID, true); existingErr == nil {
		if existing.ParentSessionID != request.SourceSessionID ||
			existing.BranchFromMessageID != request.BranchFromMessageID {
			return SessionProjection{}, ErrBranchConflict
		}
		return existing, nil
	} else if !errors.Is(existingErr, ErrNotFound) {
		return SessionProjection{}, existingErr
	}

	var sourceRevision, sourceGeneration int64
	var sourceTitleBlob []byte
	if err := tx.QueryRowContext(ctx, `SELECT revision,generation,title FROM sessions WHERE id=?`, request.SourceSessionID).
		Scan(&sourceRevision, &sourceGeneration, &sourceTitleBlob); errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrNotFound
	} else if err != nil {
		return SessionProjection{}, err
	}
	if request.ExpectedSourceRevision > 0 && request.ExpectedSourceRevision != sourceRevision {
		return SessionProjection{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedSourceRevision, sourceRevision)
	}

	var cursorSequence int64
	var cursorRole string
	if err := tx.QueryRowContext(ctx, `SELECT sequence,role FROM messages WHERE id=? AND session_id=?`, request.BranchFromMessageID, request.SourceSessionID).
		Scan(&cursorSequence, &cursorRole); errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrInvalidBranchCursor
	} else if err != nil {
		return SessionProjection{}, err
	}
	if strings.TrimSpace(cursorRole) != "user" || cursorSequence <= 0 {
		return SessionProjection{}, ErrInvalidBranchCursor
	}

	title := strings.TrimSpace(request.Title)
	if title == "" {
		if err := l.openJSON("sessions", request.SourceSessionID, "title", sourceTitleBlob, &title); err != nil {
			return SessionProjection{}, err
		}
	}
	titleBlob, err := l.seal("sessions", request.SessionID, "title", title)
	if err != nil {
		return SessionProjection{}, err
	}
	now := nowUTC()
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,revision,generation,title,parent_session_id,branch_from_message_id,branch_from_sequence,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		request.SessionID, 1, sourceGeneration+1, titleBlob, request.SourceSessionID, request.BranchFromMessageID, cursorSequence, 0, toNano(now), toNano(now)); err != nil {
		return SessionProjection{}, err
	}

	messages, err := l.getMessagesBeforeSequenceTx(ctx, tx, request.SourceSessionID, cursorSequence)
	if err != nil {
		return SessionProjection{}, err
	}
	for _, source := range messages {
		copy := source
		copy.ID = uuid.NewString()
		copy.SessionID = request.SessionID
		// The originating run belongs to the source session. Keeping it in the
		// branch would make a provider projection look like it can resume an old
		// tool execution, so branch copies intentionally become transcript-only.
		copy.RunID = ""
		copy.CreatedAt = now
		if err := l.appendMessageTx(ctx, tx, copy); err != nil {
			return SessionProjection{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, request.SessionID, true)
}

func (l *Ledger) ensureSessionTx(ctx context.Context, tx *sql.Tx, id, title string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		id = uuid.NewString()
	}
	var found string
	err := tx.QueryRowContext(ctx, `SELECT id FROM sessions WHERE id=?`, id).Scan(&found)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	now := nowUTC()
	titleBlob, err := l.seal("sessions", id, "title", strings.TrimSpace(title))
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,revision,generation,title,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, 1, 1, titleBlob, 0, toNano(now), toNano(now)); err != nil {
		return "", err
	}
	return id, nil
}

func (l *Ledger) getSessionTx(ctx context.Context, tx *sql.Tx, id string, includeMessages bool) (SessionProjection, error) {
	var revision, generation, branchFromSequence, archived, created, updated int64
	var titleBlob []byte
	var parentSessionID, branchFromMessageID string
	err := tx.QueryRowContext(ctx, `SELECT id,revision,generation,title,COALESCE(parent_session_id,''),COALESCE(branch_from_message_id,''),branch_from_sequence,archived,created_at,updated_at FROM sessions WHERE id=?`, id).Scan(&id, &revision, &generation, &titleBlob, &parentSessionID, &branchFromMessageID, &branchFromSequence, &archived, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrNotFound
	}
	if err != nil {
		return SessionProjection{}, err
	}
	title, err := l.sessionDisplayTitleTx(ctx, tx, id, titleBlob)
	if err != nil {
		return SessionProjection{}, err
	}
	projection := SessionProjection{ID: id, Title: title, Revision: revision, Generation: generation,
		ParentSessionID: parentSessionID, BranchFromMessageID: branchFromMessageID,
		BranchFromSequence: branchFromSequence, Archived: archived != 0,
		CreatedAt: fromNano(created), UpdatedAt: fromNano(updated)}
	rows, err := tx.QueryContext(ctx, `SELECT `+runColumns+` FROM runs WHERE session_id=? ORDER BY created_at,id`, id)
	if err != nil {
		return SessionProjection{}, err
	}
	for rows.Next() {
		run, scanErr := scanRun(rows, l)
		if scanErr != nil {
			rows.Close()
			return SessionProjection{}, scanErr
		}
		projection.Runs = append(projection.Runs, run)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SessionProjection{}, err
	}
	rows.Close()
	if includeMessages {
		messages, err := l.getMessagesTx(ctx, tx, id, 0, 0)
		if err != nil {
			return SessionProjection{}, err
		}
		projection.Messages = messages
	}
	return projection, nil
}

func (l *Ledger) getSessionDB(ctx context.Context, id string, includeMessages bool) (SessionProjection, error) {
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()
	projection, err := l.getSessionTx(ctx, tx, id, includeMessages)
	if err != nil {
		return SessionProjection{}, err
	}
	return projection, nil
}

func (l *Ledger) GetSession(ctx context.Context, id string, includeMessages bool) (SessionProjection, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, strings.TrimSpace(id), includeMessages)
}

func (l *Ledger) MutateSession(ctx context.Context, request SessionMutationRequest) (SessionProjection, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	if strings.TrimSpace(request.SessionID) == "" {
		return SessionProjection{}, errors.New("sessionId is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()
	var revision, generation, archived int64
	var titleBlob []byte
	if err := tx.QueryRowContext(ctx, `SELECT revision,generation,archived,title FROM sessions WHERE id=?`, request.SessionID).Scan(&revision, &generation, &archived, &titleBlob); errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrNotFound
	} else if err != nil {
		return SessionProjection{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != revision {
		return SessionProjection{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, revision)
	}
	newRevision := revision + 1
	setTitle := titleBlob
	if request.Title != nil {
		setTitle, err = l.seal("sessions", request.SessionID, "title", strings.TrimSpace(*request.Title))
		if err != nil {
			return SessionProjection{}, err
		}
	}
	newArchived := archived
	if request.Archived != nil {
		newArchived = int64(boolInt(*request.Archived))
	}
	result, err := tx.ExecContext(ctx, `UPDATE sessions SET revision=?,title=?,archived=?,updated_at=? WHERE id=? AND revision=?`, newRevision, setTitle, newArchived, toNano(nowUTC()), request.SessionID, revision)
	if err != nil {
		return SessionProjection{}, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return SessionProjection{}, err
	} else if affected != 1 {
		return SessionProjection{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, request.SessionID, true)
}

func (l *Ledger) ListSessions(ctx context.Context, request SessionListRequest) (SessionListResult, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return SessionListResult{}, err
	}
	limit := request.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	offset := request.Offset
	if offset < 0 {
		offset = 0
	}
	where, args := sessionListWhere(request.ActiveOnly)
	var total int
	if err := l.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions s`+where, args...).Scan(&total); err != nil {
		return SessionListResult{}, err
	}
	rows, err := l.db.QueryContext(ctx, `SELECT id FROM sessions s`+where+` ORDER BY updated_at DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return SessionListResult{}, err
	}
	// Materialize IDs before opening a read transaction for each projection.
	// Keeping rows open while calling getSessionDB can exhaust the SQLite pool
	// (the cursor pins one connection and each projection needs another).
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return SessionListResult{}, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return SessionListResult{}, err
	}
	if err := rows.Err(); err != nil {
		return SessionListResult{}, err
	}
	result := SessionListResult{Total: total, Sessions: make([]SessionProjection, 0, len(ids))}
	for _, id := range ids {
		projection, err := l.getSessionDB(ctx, id, false)
		if err != nil {
			return SessionListResult{}, err
		}
		result.Sessions = append(result.Sessions, projection)
	}
	return result, nil
}
