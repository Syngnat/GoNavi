package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type githubClient struct {
	baseURL string
	repo    string
	token   string
	client  *http.Client
}

type reviewComment struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Side string `json:"side"`
	Body string `json:"body"`
}

type issueComment struct {
	ID   int64  `json:"id"`
	Body string `json:"body"`
}

func (g *githubClient) listCheckRuns(ctx context.Context, sha string) ([]checkRun, error) {
	sha = strings.TrimSpace(sha)
	if sha == "" {
		return nil, nil
	}
	var runs []checkRun
	for page := 1; page <= 5; page++ {
		endpoint := fmt.Sprintf("%s/repos/%s/commits/%s/check-runs?per_page=100&page=%d", g.baseURL, g.repo, url.PathEscape(sha), page)
		var payload struct {
			CheckRuns []checkRun `json:"check_runs"`
		}
		if err := g.get(ctx, endpoint, &payload); err != nil {
			return nil, err
		}
		runs = append(runs, payload.CheckRuns...)
		if len(payload.CheckRuns) < 100 {
			break
		}
	}
	return runs, nil
}

func (g *githubClient) pullRequestForSHA(ctx context.Context, sha string) (int, error) {
	endpoint := fmt.Sprintf("%s/repos/%s/commits/%s/pulls", g.baseURL, g.repo, url.PathEscape(strings.TrimSpace(sha)))
	var pulls []struct {
		Number int    `json:"number"`
		State  string `json:"state"`
	}
	if err := g.get(ctx, endpoint, &pulls); err != nil {
		return 0, err
	}
	for _, pr := range pulls {
		if pr.State == "open" {
			return pr.Number, nil
		}
	}
	return 0, nil
}

func (g *githubClient) listFiles(ctx context.Context, pr int) ([]FileChange, error) {
	var files []FileChange
	for page := 1; page <= 10; page++ {
		endpoint := fmt.Sprintf("%s/repos/%s/pulls/%d/files?per_page=100&page=%d", g.baseURL, g.repo, pr, page)
		var batch []FileChange
		if err := g.get(ctx, endpoint, &batch); err != nil {
			return nil, err
		}
		files = append(files, batch...)
		if len(batch) < 100 {
			break
		}
	}
	return files, nil
}

func (g *githubClient) upsertComment(ctx context.Context, pr int, body string) error {
	endpoint := fmt.Sprintf("%s/repos/%s/issues/%d/comments?per_page=100&sort=created&direction=desc", g.baseURL, g.repo, pr)
	var comments []issueComment
	if err := g.get(ctx, endpoint, &comments); err != nil {
		return err
	}
	for i := len(comments) - 1; i >= 0; i-- {
		if strings.Contains(comments[i].Body, reviewMarker) {
			update := fmt.Sprintf("%s/repos/%s/issues/comments/%d", g.baseURL, g.repo, comments[i].ID)
			return g.send(ctx, http.MethodPatch, update, map[string]string{"body": body}, nil)
		}
	}
	create := fmt.Sprintf("%s/repos/%s/issues/%d/comments", g.baseURL, g.repo, pr)
	return g.send(ctx, http.MethodPost, create, map[string]string{"body": body}, nil)
}

func (g *githubClient) createReview(ctx context.Context, pr int, sha string, comments []reviewComment) error {
	if len(comments) == 0 {
		return nil
	}
	for i := range comments {
		comments[i].Side = "RIGHT"
	}
	endpoint := fmt.Sprintf("%s/repos/%s/pulls/%d/reviews", g.baseURL, g.repo, pr)
	payload := map[string]any{
		"commit_id": sha,
		"event":     "COMMENT",
		"body":      "行内意见对应汇总评论里的「需要处理」。",
		"comments":  comments,
	}
	return g.send(ctx, http.MethodPost, endpoint, payload, nil)
}

func (g *githubClient) get(ctx context.Context, endpoint string, out any) error {
	return g.send(ctx, http.MethodGet, endpoint, nil, out)
}

func (g *githubClient) send(ctx context.Context, method, endpoint string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "GoNavi-PR-Review")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GitHub API %s 返回 HTTP %d", method, resp.StatusCode)
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func parseRepo(repo string) (string, error) {
	repo = strings.Trim(strings.TrimSpace(repo), "/")
	owner, name, ok := strings.Cut(repo, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", fmt.Errorf("仓库名必须是 owner/name")
	}
	return url.PathEscape(owner) + "/" + url.PathEscape(name), nil
}

func parsePRNumber(value string) (int, error) {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || number <= 0 {
		return 0, fmt.Errorf("PR 编号无效")
	}
	return number, nil
}
