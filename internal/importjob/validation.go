package importjob

import (
	"errors"
	"strings"
)

var ErrResumeUnsafe = errors.New("import job cannot be resumed safely")

func ValidateResume(job Job, sourceIdentityToken, targetFingerprint, optionsHash string) error {
	if job.Status != StatusInterrupted || !job.Resumable || !job.Checkpoint.Safe || job.OutcomeUnknown {
		return ErrResumeUnsafe
	}
	if strings.TrimSpace(sourceIdentityToken) == "" || sourceIdentityToken != job.SourceIdentityToken {
		return ErrResumeUnsafe
	}
	if strings.TrimSpace(targetFingerprint) == "" || targetFingerprint != job.TargetFingerprint {
		return ErrResumeUnsafe
	}
	if strings.TrimSpace(optionsHash) == "" || optionsHash != job.OptionsHash {
		return ErrResumeUnsafe
	}
	return nil
}
