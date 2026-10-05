//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"errors"
	"io"
	"sort"
	"time"

	kafka "github.com/segmentio/kafka-go"
)

func (r *kafkaGoRuntime) fetchMessagesWithGroup(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:         append([]string(nil), r.brokers...),
		GroupID:         request.GroupID,
		Topic:           request.Topic,
		Dialer:          r.dialer,
		QueueCapacity:   maxInt(request.Limit+request.Offset, 1),
		MinBytes:        1,
		MaxBytes:        kafkaFetchMaxBytes,
		MaxWait:         r.readWait,
		ReadLagInterval: -1,
		CommitInterval:  0,
		StartOffset:     kafkaOffsetMode(request.Latest),
		MaxAttempts:     1,
	})
	defer reader.Close()

	target := request.Limit + request.Offset
	records := make([]kafkaMessageRecord, 0, request.Limit)
	skipped := 0
	for len(records) < request.Limit && skipped+len(records) < target {
		readCtx, cancel := context.WithTimeout(ctx, r.readWait)
		msg, err := reader.FetchMessage(readCtx)
		cancel()
		if err != nil {
			if isKafkaReadTimeout(err) || errorsIsContextTimeout(err) {
				break
			}
			return nil, err
		}
		record := kafkaMessageRecord{
			Message: msg,
			Key:     kafkaDecodePayload(msg.Key),
			Value:   kafkaDecodePayload(msg.Value),
			Headers: kafkaHeadersToMap(msg.Headers),
		}
		if skipped < request.Offset {
			skipped++
			continue
		}
		records = append(records, record)
	}
	return records, nil
}

func (r *kafkaGoRuntime) fetchMessagesDirect(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error) {
	partitions, err := r.dialer.LookupPartitions(ctx, "tcp", r.bootstrap, request.Topic)
	if err != nil {
		return nil, err
	}
	sort.Slice(partitions, func(i, j int) bool {
		return partitions[i].ID < partitions[j].ID
	})
	target := maxInt(request.Limit+request.Offset, request.Limit)
	records := make([]kafkaMessageRecord, 0, target)
	for _, partition := range partitions {
		start, err := r.partitionStartOffset(ctx, request.Topic, partition.ID, request.Latest, target)
		if err != nil {
			return nil, err
		}
		items, err := r.fetchPartitionMessages(ctx, request.Topic, partition.ID, start, target)
		if err != nil {
			return nil, err
		}
		records = append(records, items...)
	}
	sortKafkaRecords(records, request.Latest)
	if request.Offset >= len(records) {
		return []kafkaMessageRecord{}, nil
	}
	records = records[request.Offset:]
	if len(records) > request.Limit {
		records = records[:request.Limit]
	}
	return records, nil
}

func (r *kafkaGoRuntime) partitionStartOffset(ctx context.Context, topic string, partitionID int, latest bool, limit int) (int64, error) {
	first, last, err := r.partitionOffsets(ctx, topic, partitionID)
	if err != nil {
		return 0, err
	}
	if !latest {
		return first, nil
	}
	start := last - int64(limit)
	if start < first {
		start = first
	}
	return start, nil
}

func (r *kafkaGoRuntime) partitionOffsets(ctx context.Context, topic string, partitionID int) (int64, int64, error) {
	conn, err := r.dialer.DialLeader(ctx, "tcp", r.bootstrap, topic, partitionID)
	if err != nil {
		return 0, 0, err
	}
	defer conn.Close()
	return conn.ReadOffsets()
}

type kafkaOffsetSeeker interface {
	Seek(offset int64, whence int) (int64, error)
}

func seekKafkaAbsoluteOffset(conn kafkaOffsetSeeker, offset int64) error {
	_, err := conn.Seek(offset, kafka.SeekAbsolute)
	return err
}

func (r *kafkaGoRuntime) fetchPartitionMessages(ctx context.Context, topic string, partitionID int, startOffset int64, limit int) ([]kafkaMessageRecord, error) {
	conn, err := r.dialer.DialLeader(ctx, "tcp", r.bootstrap, topic, partitionID)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := seekKafkaAbsoluteOffset(conn, startOffset); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(r.readWait)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	_ = conn.SetReadDeadline(deadline)

	records := make([]kafkaMessageRecord, 0, limit)
	for len(records) < limit {
		msg, err := conn.ReadMessage(kafkaFetchMaxBytes)
		if err != nil {
			if isKafkaReadTimeout(err) || errorsIsContextTimeout(err) || errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
		records = append(records, kafkaMessageRecord{
			Message: msg,
			Key:     kafkaDecodePayload(msg.Key),
			Value:   kafkaDecodePayload(msg.Value),
			Headers: kafkaHeadersToMap(msg.Headers),
		})
	}
	return records, nil
}
