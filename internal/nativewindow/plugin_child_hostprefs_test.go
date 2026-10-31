package nativewindow

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// injectAfterHead 应把片段插到首个 <head> 标签之后；偏移为零时前置回退。
func TestInjectAfterHead(t *testing.T) {
	body := []byte("<html><head><title>x</title></head><body>hi</body></html>")
	out, ok := injectAfterHead(body, []byte("SNIPPET"))
	if !ok {
		t.Fatal("expected injection")
	}
	if !strings.HasPrefix(string(out), "<html><head>SNIPPET<title>") {
		t.Fatalf("injected at wrong position: %q", out)
	}
	// 原 body 不被修改。
	if string(body) != "<html><head><title>x</title></head><body>hi</body></html>" {
		t.Fatalf("original body mutated: %q", body)
	}
	if _, ok := injectAfterHead([]byte("<body>no head</body>"), []byte("S")); ok {
		t.Fatal("expected fallback when head missing")
	}
}

// modifyHTML 只改 HTML 响应并注入 JSON 形态的宿主偏好。
func TestModifyHTMLInjectsPrefs(t *testing.T) {
	prefs := injectHostPrefs{locale: "zh-CN", theme: "dark"}
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:       io.NopCloser(bytes.NewReader([]byte("<html><head></head><body></body></html>"))),
	}
	if err := prefs.modifyHTML(resp); err != nil {
		t.Fatalf("modifyHTML: %v", err)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read modified body: %v", err)
	}
	if !strings.Contains(string(data), `window.gonaviHostPrefs={"locale":"zh-CN","theme":"dark"}`) {
		t.Fatalf("prefs snippet missing: %q", data)
	}

	// 非 HTML 响应不动。
	other := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/javascript"}},
		Body:       io.NopCloser(bytes.NewReader([]byte("var x=1"))),
	}
	if err := prefs.modifyHTML(other); err != nil {
		t.Fatalf("modifyHTML js: %v", err)
	}
	js, _ := io.ReadAll(other.Body)
	if string(js) != "var x=1" {
		t.Fatalf("non-html body must stay unchanged: %q", js)
	}
}

// sanitizeHostPref 过滤不安全字符并限长。
func TestSanitizeHostPref(t *testing.T) {
	if got := sanitizeHostPref("zh-CN"); got != "zh-CN" {
		t.Fatalf("got %q", got)
	}
	if got := sanitizeHostPref(`dark"><script>`); got != "darkscript" {
		t.Fatalf("unsafe chars must be stripped, got %q", got)
	}
	if got := sanitizeHostPref(strings.Repeat("a", 100)); len(got) != 32 {
		t.Fatalf("expected cap at 32, got %d", len(got))
	}
	if got := sanitizeHostPref(""); got != "" {
		t.Fatalf("empty stays empty, got %q", got)
	}
}

func TestInjectAfterHeadUsesRawHTMLPositions(t *testing.T) {
	for _, test := range []struct {
		name, before, after string
		ok                  bool
	}{
		{name: "comment fake head", before: `<!doctype html><!-- <head>fake</head> --><html><head>`, after: "<title>x</title></head></html>", ok: true},
		{name: "quoted greater than", before: `<html><HEAD data-note=">" data-other='a>b'>`, after: "</HEAD></html>", ok: true},
		{name: "Unicode byte offsets", before: `<!-- İ界🙂 --><html><head title="选择 > файл">`, after: "</head><body>界🙂</body></html>", ok: true},
		{name: "head prefix is not head", before: "", after: "<header>heading</header>", ok: false},
		{name: "head inside script", before: "", after: `<script>const x='<head>';</script><body>no head</body>`, ok: false},
		{name: "no head preserves doctype", before: "<!doctype html><html>", after: "<body>no head</body></html>", ok: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := []byte(test.before + test.after)
			original := append([]byte(nil), body...)
			out, ok := injectAfterHead(body, []byte("SNIPPET"))
			if ok != test.ok {
				t.Fatalf("injected=%v want=%v", ok, test.ok)
			}
			if ok && string(out) != test.before+"SNIPPET"+test.after {
				t.Fatalf("wrong raw offset: %q", out)
			}
			if !bytes.Equal(body, original) {
				t.Fatal("original HTML changed")
			}
		})
	}
}

func TestModifyHTMLKeepsBodyLengthConsistent(t *testing.T) {
	prefs := injectHostPrefs{locale: "zh-CN", theme: "dark"}
	for _, body := range []string{"<html><head></head></html>", "<body>界🙂</body>"} {
		resp := &http.Response{StatusCode: 200, ContentLength: int64(len(body)),
			Header: http.Header{"Content-Type": {"text/html"}, "Content-Length": {strconv.Itoa(len(body))}},
			Body:   io.NopCloser(strings.NewReader(body))}
		if err := prefs.modifyHTML(resp); err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.ContentLength != int64(len(data)) {
			t.Fatalf("ContentLength=%d body bytes=%d", resp.ContentLength, len(data))
		}
		if resp.Header.Get("Content-Length") != "" || resp.Header.Get("Transfer-Encoding") != "" || len(resp.TransferEncoding) != 0 {
			t.Fatalf("unexpected framing metadata: header=%v transfer=%v", resp.Header, resp.TransferEncoding)
		}
		if strings.HasPrefix(body, "<body>") && !strings.HasPrefix(string(data), "<script>if(!window.gonaviHostPrefs)window.gonaviHostPrefs=") {
			t.Fatalf("missing head fallback: %q", data)
		}
	}
}
