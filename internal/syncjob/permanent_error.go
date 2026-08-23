package syncjob

// PermanentExecutionError marks an execution failure that cannot be repaired by
// retrying the same persisted task definition. The manager pauses the task only
// when the owning executor successfully commits this run's failed terminal state.
type PermanentExecutionError struct {
	Err error
}

func (e *PermanentExecutionError) Error() string {
	if e == nil || e.Err == nil {
		return "permanent data sync execution failure"
	}
	return e.Err.Error()
}

func (e *PermanentExecutionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func MarkPermanentExecutionError(err error) error {
	if err == nil {
		return nil
	}
	return &PermanentExecutionError{Err: err}
}
