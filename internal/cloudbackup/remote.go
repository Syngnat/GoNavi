package cloudbackup

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	ProviderWebDAV = "webdav"
	ProviderS3     = "s3"
	webDAVMKCOL    = "MKCOL"
)

type RemoteConfig struct {
	Provider  string
	Endpoint  string
	Bucket    string
	ObjectKey string
	Region    string
}

type Credentials struct {
	Username  string
	Password  string
	AccessKey string
	SecretKey string
}

type ObjectMetadata struct {
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	Size         int64  `json:"size,omitempty"`
}

type Remote interface {
	Put(context.Context, []byte) (ObjectMetadata, error)
	Get(context.Context) ([]byte, ObjectMetadata, error)
	Head(context.Context) (ObjectMetadata, error)
}

func NewRemote(config RemoteConfig, credentials Credentials, client *http.Client) (Remote, error) {
	config.Provider = strings.ToLower(strings.TrimSpace(config.Provider))
	config.Endpoint = strings.TrimRight(strings.TrimSpace(config.Endpoint), "/")
	config.ObjectKey = strings.Trim(strings.TrimSpace(config.ObjectKey), "/")
	if config.Endpoint == "" {
		return nil, errors.New("backup endpoint is required")
	}
	parsed, err := url.Parse(config.Endpoint)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("backup endpoint must be an absolute URL")
	}
	if parsed.Scheme != "https" && !isLoopbackHost(parsed.Hostname()) {
		return nil, errors.New("backup endpoint must use HTTPS unless it targets localhost")
	}
	if client == nil {
		client = &http.Client{Timeout: 45 * time.Second}
	}
	switch config.Provider {
	case ProviderWebDAV:
		if config.ObjectKey == "" {
			return nil, errors.New("WebDAV backup file path is required")
		}
		if strings.TrimSpace(credentials.Username) == "" || strings.TrimSpace(credentials.Password) == "" {
			return nil, errors.New("WebDAV username and password are required")
		}
		return &webDAVRemote{config: config, credentials: credentials, client: client}, nil
	case ProviderS3:
		if config.ObjectKey == "" {
			return nil, errors.New("S3 object key is required")
		}
		if strings.TrimSpace(config.Bucket) == "" || strings.TrimSpace(config.Region) == "" || strings.TrimSpace(credentials.AccessKey) == "" || strings.TrimSpace(credentials.SecretKey) == "" {
			return nil, errors.New("S3 bucket, region, access key and secret key are required")
		}
		return &s3Remote{config: config, credentials: credentials, client: client}, nil
	default:
		return nil, fmt.Errorf("unsupported backup provider: %s", config.Provider)
	}
}

type webDAVRemote struct {
	config      RemoteConfig
	credentials Credentials
	client      *http.Client
}

func (r *webDAVRemote) objectURL() string {
	base, err := url.Parse(r.config.Endpoint)
	if err != nil {
		return ""
	}
	base.Path = appendObjectPath(base.Path, r.config.ObjectKey)
	base.RawPath = ""
	return base.String()
}

func (r *webDAVRemote) request(ctx context.Context, method string, body []byte) (*http.Response, error) {
	return r.requestURL(ctx, method, r.objectURL(), body)
}

func (r *webDAVRemote) requestURL(ctx context.Context, method, requestURL string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(r.credentials.Username, r.credentials.Password)
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	return r.client.Do(req)
}

func (r *webDAVRemote) Put(ctx context.Context, body []byte) (ObjectMetadata, error) {
	resp, err := r.request(ctx, http.MethodPut, body)
	if err != nil {
		return ObjectMetadata{}, err
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		defer resp.Body.Close()
		return ObjectMetadata{ETag: strings.Trim(resp.Header.Get("ETag"), `"`)}, nil
	}
	putErr := readRemoteError(resp)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusConflict {
		return ObjectMetadata{}, putErr
	}
	collectionURLs := r.collectionURLs()
	if len(collectionURLs) == 0 {
		return ObjectMetadata{}, putErr
	}
	if err := r.ensureCollections(ctx, collectionURLs); err != nil {
		return ObjectMetadata{}, err
	}
	resp, err = r.request(ctx, http.MethodPut, body)
	if err != nil {
		return ObjectMetadata{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ObjectMetadata{}, readRemoteError(resp)
	}
	return ObjectMetadata{ETag: strings.Trim(resp.Header.Get("ETag"), `"`)}, nil
}

func (r *webDAVRemote) collectionURLs() []string {
	base, err := url.Parse(r.config.Endpoint)
	if err != nil {
		return nil
	}
	segments := strings.Split(r.config.ObjectKey, "/")
	urls := make([]string, 0, len(segments)-1)
	for _, segment := range segments[:len(segments)-1] {
		if strings.TrimSpace(segment) == "" {
			continue
		}
		base.Path = appendObjectPath(base.Path, segment)
		base.RawPath = ""
		urls = append(urls, base.String())
	}
	return urls
}

func (r *webDAVRemote) ensureCollections(ctx context.Context, collectionURLs []string) error {
	for _, collectionURL := range collectionURLs {
		resp, err := r.requestURL(ctx, webDAVMKCOL, collectionURL, nil)
		if err != nil {
			return err
		}
		if (resp.StatusCode < 200 || resp.StatusCode >= 300) && resp.StatusCode != http.StatusMethodNotAllowed {
			requestErr := readRemoteError(resp)
			_ = resp.Body.Close()
			return requestErr
		}
		_ = resp.Body.Close()
	}
	return nil
}

func (r *webDAVRemote) Get(ctx context.Context) ([]byte, ObjectMetadata, error) {
	resp, err := r.request(ctx, http.MethodGet, nil)
	if err != nil {
		return nil, ObjectMetadata{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ObjectMetadata{}, readRemoteError(resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxEnvelopeBytes+1))
	if err != nil {
		return nil, ObjectMetadata{}, err
	}
	if len(body) > maxEnvelopeBytes {
		return nil, ObjectMetadata{}, errors.New("remote backup is too large")
	}
	return body, responseMetadata(resp), nil
}

func (r *webDAVRemote) Head(ctx context.Context) (ObjectMetadata, error) {
	resp, err := r.request(ctx, http.MethodHead, nil)
	if err != nil {
		return ObjectMetadata{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ObjectMetadata{}, readRemoteError(resp)
	}
	return responseMetadata(resp), nil
}

type s3Remote struct {
	config      RemoteConfig
	credentials Credentials
	client      *http.Client
}

func (r *s3Remote) objectURL() (string, string, error) {
	base, err := url.Parse(r.config.Endpoint)
	if err != nil {
		return "", "", err
	}
	base.Path = appendObjectPath(base.Path, strings.Join(append([]string{r.config.Bucket}, strings.Split(r.config.ObjectKey, "/")...), "/"))
	base.RawPath = ""
	return base.String(), base.EscapedPath(), nil
}

func appendObjectPath(basePath, objectPath string) string {
	path := strings.TrimSuffix(strings.TrimSpace(basePath), "/")
	for _, segment := range strings.Split(objectPath, "/") {
		if strings.TrimSpace(segment) == "" {
			continue
		}
		path += "/" + segment
	}
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		return "/" + path
	}
	return path
}

func (r *s3Remote) do(ctx context.Context, method string, body []byte) (*http.Response, error) {
	requestURL, canonicalURI, err := r.objectURL()
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(requestURL)
	if err != nil {
		return nil, err
	}
	payloadHash := sha256Hex(body)
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")
	canonicalHeaders := "host:" + parsed.Host + "\n" + "x-amz-content-sha256:" + payloadHash + "\n" + "x-amz-date:" + amzDate + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{method, canonicalURI, "", canonicalHeaders, signedHeaders, payloadHash}, "\n")
	credentialScope := date + "/" + r.config.Region + "/s3/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex([]byte(canonicalRequest))}, "\n")
	signature := hex.EncodeToString(signingKey([]byte(r.credentials.SecretKey), date, r.config.Region, "s3", stringToSign))
	req, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Host", parsed.Host)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+r.credentials.AccessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature)
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	return r.client.Do(req)
}

func (r *s3Remote) Put(ctx context.Context, body []byte) (ObjectMetadata, error) {
	resp, err := r.do(ctx, http.MethodPut, body)
	if err != nil {
		return ObjectMetadata{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ObjectMetadata{}, readRemoteError(resp)
	}
	return ObjectMetadata{ETag: strings.Trim(resp.Header.Get("ETag"), `"`)}, nil
}

func (r *s3Remote) Get(ctx context.Context) ([]byte, ObjectMetadata, error) {
	resp, err := r.do(ctx, http.MethodGet, nil)
	if err != nil {
		return nil, ObjectMetadata{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ObjectMetadata{}, readRemoteError(resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxEnvelopeBytes+1))
	if err != nil {
		return nil, ObjectMetadata{}, err
	}
	if len(body) > maxEnvelopeBytes {
		return nil, ObjectMetadata{}, errors.New("remote backup is too large")
	}
	return body, responseMetadata(resp), nil
}

func (r *s3Remote) Head(ctx context.Context) (ObjectMetadata, error) {
	resp, err := r.do(ctx, http.MethodHead, nil)
	if err != nil {
		return ObjectMetadata{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ObjectMetadata{}, readRemoteError(resp)
	}
	return responseMetadata(resp), nil
}

func signingKey(secret []byte, date, region, service, value string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+string(secret)), []byte(date))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	return hmacSHA256(kSigning, []byte(value))
}

func hmacSHA256(key, value []byte) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write(value)
	return h.Sum(nil)
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func responseMetadata(resp *http.Response) ObjectMetadata {
	var size int64
	if resp.ContentLength >= 0 {
		size = resp.ContentLength
	}
	return ObjectMetadata{ETag: strings.Trim(resp.Header.Get("ETag"), `"`), LastModified: resp.Header.Get("Last-Modified"), Size: size}
}

func readRemoteError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	detail := strings.TrimSpace(string(body))
	if detail == "" {
		detail = resp.Status
	}
	return fmt.Errorf("remote backup request failed: %s: %s", resp.Status, detail)
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
