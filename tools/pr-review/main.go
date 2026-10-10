package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	repoFlag := flag.String("repo", os.Getenv("GITHUB_REPOSITORY"), "owner/name")
	prFlag := flag.String("pr", "", "pull request number")
	shaFlag := flag.String("sha", "", "head commit SHA")
	flag.Parse()

	if err := run(context.Background(), *repoFlag, *prFlag, *shaFlag, os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}

func run(ctx context.Context, repoName, prText, sha string, env func(string) string) error {
	repo, err := parseRepo(repoName)
	if err != nil {
		return err
	}
	token := strings.TrimSpace(env("GITHUB_TOKEN"))
	if token == "" {
		return fmt.Errorf("缺少 GITHUB_TOKEN")
	}
	client := &githubClient{
		baseURL: "https://api.github.com",
		repo:    repo,
		token:   token,
		client:  &http.Client{Timeout: 30 * time.Second},
	}
	sha = strings.TrimSpace(sha)
	pr, err := resolvePullRequest(ctx, client, prText, sha)
	if err != nil {
		return err
	}
	if pr == 0 {
		fmt.Fprintln(os.Stderr, "这个提交没有对应的 pull request，跳过回复")
		return nil
	}
	files, err := client.listFiles(ctx, pr)
	if err != nil {
		return err
	}
	findings := reviewFiles(files)
	modelSummary := ""
	summary, modelFindings, modelErr := reviewWithFreeModels(ctx, nil, env, files)
	if modelErr != nil {
		fmt.Fprintf(os.Stderr, "模型评审跳过：%v\n", modelErr)
	} else {
		modelSummary = summary
		findings = append(findings, modelFindings...)
	}
	checks, err := client.listCheckRuns(ctx, sha)
	if err != nil {
		return err
	}
	body := renderComment(findings, modelSummary, gateReport(checks))
	if err := client.upsertComment(ctx, pr, body); err != nil {
		return err
	}
	if err := client.createReview(ctx, pr, sha, inlineComments(findings)); err != nil {
		fmt.Fprintf(os.Stderr, "行内评论未发表：%v\n", err)
	}
	return nil
}

func resolvePullRequest(ctx context.Context, client *githubClient, prText, sha string) (int, error) {
	if strings.TrimSpace(prText) != "" {
		return parsePRNumber(prText)
	}
	if sha == "" {
		return 0, fmt.Errorf("缺少 PR 编号或提交 SHA")
	}
	return client.pullRequestForSHA(ctx, sha)
}
