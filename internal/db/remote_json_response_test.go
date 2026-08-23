package db

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type responseBodyRoundTripper func(*http.Request) (*http.Response, error)

func (fn responseBodyRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type trackedResponseBody struct {
	reader io.Reader
	closed bool
}

func (body *trackedResponseBody) Read(buffer []byte) (int, error) {
	return body.reader.Read(buffer)
}

func (body *trackedResponseBody) Close() error {
	body.closed = true
	return nil
}

type repeatingResponseReader struct {
	remaining int
}

func (reader *repeatingResponseReader) Read(buffer []byte) (int, error) {
	if reader.remaining == 0 {
		return 0, io.EOF
	}
	if len(buffer) > reader.remaining {
		buffer = buffer[:reader.remaining]
	}
	for index := range buffer {
		buffer[index] = 'x'
	}
	reader.remaining -= len(buffer)
	return len(buffer), nil
}

func newResponseBodyClient(statusCode int, body io.ReadCloser) *http.Client {
	return &http.Client{Transport: responseBodyRoundTripper(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: statusCode,
			Status:     http.StatusText(statusCode),
			Header:     make(http.Header),
			Body:       body,
			Request:    request,
		}, nil
	})}
}

func assertOversizedJSONResponseRejectedAndClosed(t *testing.T, call func(*http.Client) error) {
	t.Helper()
	for _, statusCode := range []int{http.StatusOK, http.StatusBadGateway} {
		t.Run(http.StatusText(statusCode), func(t *testing.T) {
			body := &trackedResponseBody{reader: &repeatingResponseReader{remaining: maxRemoteJSONResponseBytes + 1}}
			err := call(newResponseBodyClient(statusCode, body))
			if err == nil || !strings.Contains(err.Error(), "响应超过 32 MiB 上限") {
				t.Fatalf("oversized response error = %v", err)
			}
			if !body.closed {
				t.Fatal("response body was not closed")
			}
		})
	}
}

func assertSmallJSONResponseCompatibleAndClosed(t *testing.T, response string, call func(*http.Client) error) {
	t.Helper()
	body := &trackedResponseBody{reader: strings.NewReader(response)}
	if err := call(newResponseBodyClient(http.StatusOK, body)); err != nil {
		t.Fatalf("small response error = %v", err)
	}
	if !body.closed {
		t.Fatal("response body was not closed")
	}
}

func TestChromaDoJSONResponseBodyLimit(t *testing.T) {
	t.Run("oversized response", func(t *testing.T) {
		assertOversizedJSONResponseRejectedAndClosed(t, func(client *http.Client) error {
			return (&ChromaDB{client: client, baseURL: "http://chroma.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &map[string]interface{}{})
		})
	})

	t.Run("small response", func(t *testing.T) {
		assertSmallJSONResponseCompatibleAndClosed(t, `{"ok":true}`, func(client *http.Client) error {
			result := map[string]interface{}{}
			err := (&ChromaDB{client: client, baseURL: "http://chroma.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &result)
			if result["ok"] != true {
				t.Fatalf("decoded result = %#v", result)
			}
			return err
		})
	})
}

func TestMilvusDoJSONResponseBodyLimit(t *testing.T) {
	t.Run("oversized response", func(t *testing.T) {
		assertOversizedJSONResponseRejectedAndClosed(t, func(client *http.Client) error {
			return (&MilvusDB{client: client, baseURL: "http://milvus.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &map[string]interface{}{})
		})
	})

	t.Run("small response", func(t *testing.T) {
		assertSmallJSONResponseCompatibleAndClosed(t, `{"code":0,"data":{"ok":true}}`, func(client *http.Client) error {
			result := map[string]interface{}{}
			err := (&MilvusDB{client: client, baseURL: "http://milvus.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &result)
			if result["ok"] != true {
				t.Fatalf("decoded result = %#v", result)
			}
			return err
		})
	})
}

func TestQdrantDoJSONResponseBodyLimit(t *testing.T) {
	t.Run("oversized response", func(t *testing.T) {
		assertOversizedJSONResponseRejectedAndClosed(t, func(client *http.Client) error {
			return (&QdrantDB{client: client, baseURL: "http://qdrant.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &map[string]interface{}{})
		})
	})

	t.Run("small response", func(t *testing.T) {
		assertSmallJSONResponseCompatibleAndClosed(t, `{"ok":true}`, func(client *http.Client) error {
			result := map[string]interface{}{}
			err := (&QdrantDB{client: client, baseURL: "http://qdrant.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &result)
			if result["ok"] != true {
				t.Fatalf("decoded result = %#v", result)
			}
			return err
		})
	})
}

func TestRabbitMQDoJSONResponseBodyLimit(t *testing.T) {
	t.Run("oversized response", func(t *testing.T) {
		assertOversizedJSONResponseRejectedAndClosed(t, func(client *http.Client) error {
			return (&RabbitMQDB{client: client, baseURL: "http://rabbitmq.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &map[string]interface{}{})
		})
	})

	t.Run("small response", func(t *testing.T) {
		assertSmallJSONResponseCompatibleAndClosed(t, `{"ok":true}`, func(client *http.Client) error {
			result := map[string]interface{}{}
			err := (&RabbitMQDB{client: client, baseURL: "http://rabbitmq.test"}).doJSON(context.Background(), http.MethodGet, "/health", nil, &result)
			if result["ok"] != true {
				t.Fatalf("decoded result = %#v", result)
			}
			return err
		})
	})
}
