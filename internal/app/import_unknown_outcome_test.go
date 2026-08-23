package app

import (
	"context"
	"database/sql/driver"
	"errors"
	"testing"

	"GoNavi-Wails/internal/db"
)

type unknownAutocommitImportDB struct {
	db.Database
	calls int
	err   error
}

func (database *unknownAutocommitImportDB) ExecContext(context.Context, string) (int64, error) {
	database.calls++
	return 0, database.err
}

type unknownOutcomeImportWriter struct {
	calls int
}

func (writer *unknownOutcomeImportWriter) SetColumns([]string) {}

func (writer *unknownOutcomeImportWriter) ApplyBatch([]map[string]interface{}) error {
	return errors.New("batch path must not be used")
}

func (writer *unknownOutcomeImportWriter) ApplyOne(map[string]interface{}) error {
	writer.calls++
	return db.MarkWriteOutcomeUnknown(errors.New("commit response lost"))
}

func (writer *unknownOutcomeImportWriter) BatchEnabled() bool { return false }

func TestImportBatchConsumerStopsContinueModeOnUnknownWriteOutcome(t *testing.T) {
	writer := &unknownOutcomeImportWriter{}
	consumer := newImportBatchConsumer(writer, 10, 2, true, true, nil)

	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1}); err != nil {
		t.Fatal(err)
	}
	if err := consumer.ConsumeRow(map[string]interface{}{"id": 2}); err != nil {
		t.Fatal(err)
	}
	err := consumer.Flush()
	if !errors.Is(err, errImportStoppedOnError) {
		t.Fatalf("unknown write outcome must stop the import, got %v", err)
	}
	if !db.IsWriteOutcomeUnknown(err) {
		t.Fatalf("consumer must preserve the typed unknown-outcome cause, got %T: %v", err, err)
	}

	result := consumer.Result()
	if !result.OutcomeUnknown || !result.StoppedOnError {
		t.Fatalf("unknown write outcome was not preserved: %#v", result)
	}
	if result.Success != 0 || result.Failed != 1 || writer.calls != 1 {
		t.Fatalf("continue mode wrote past the uncertain row: result=%#v calls=%d", result, writer.calls)
	}
}

func TestImportBatchConsumerStopsContinueModeOnAmbiguousAutocommitResponse(t *testing.T) {
	for name, writeErr := range map[string]error{
		"transport":    driver.ErrBadConn,
		"cancellation": context.Canceled,
	} {
		t.Run(name, func(t *testing.T) {
			database := &unknownAutocommitImportDB{err: writeErr}
			writer := newImportDatabaseRowWriterWithOptions(database, "postgres", "users", newImportColumnTypeLookup(nil), ImportFileOptions{
				ConflictPolicy: importConflictPolicySkipDuplicates,
			})
			consumer := newImportBatchConsumer(writer, 10, 2, true, true, nil)
			if err := consumer.SetColumns([]string{"id"}); err != nil {
				t.Fatal(err)
			}
			for _, id := range []int{1, 2} {
				if err := consumer.ConsumeRow(map[string]interface{}{"id": id}); err != nil {
					t.Fatal(err)
				}
			}

			err := consumer.Flush()
			if !errors.Is(err, errImportStoppedOnError) {
				t.Fatalf("ambiguous autocommit response must stop the import, got %v", err)
			}
			if name == "cancellation" && !errors.Is(err, context.Canceled) {
				t.Fatalf("consumer lost the cancellation cause while marking the outcome unknown: %v", err)
			}
			result := consumer.Result()
			if !result.OutcomeUnknown || !result.StoppedOnError || result.Failed != 1 || database.calls != 1 {
				t.Fatalf("import continued after an ambiguous autocommit response: result=%#v calls=%d", result, database.calls)
			}
		})
	}
}
