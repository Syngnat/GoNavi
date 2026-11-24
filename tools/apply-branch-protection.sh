#!/usr/bin/env bash
# Apply the GoNavi ruleset required by the agent workflow.
#
# Default is a dry run: it prints the exact ruleset payload and changes nothing.
# Pass --apply only after checking the output and confirming you can still merge
# through the GitHub UI or bypass the ruleset as a repository admin.
set -euo pipefail

REPO="${REPO:-Syngnat/GoNavi}"
APPLY="${1:-}"

if [[ -n "${APPLY}" && "${APPLY}" != "--apply" ]]; then
  echo "usage: REPO=owner/name $0 [--apply]" >&2
  exit 2
fi

for cmd in gh jq; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "missing command: $cmd" >&2
    exit 1
  }
done

rulesets="$(gh api "repos/${REPO}/rulesets")"

for name in dev-protection main-protection; do
  id="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .id' <<<"$rulesets")"
  if [[ -z "$id" || "$id" == "null" ]]; then
    echo "ruleset not found: $name" >&2
    exit 1
  fi

  current="$(gh api "repos/${REPO}/rulesets/${id}")"
  payload="$(
    jq --arg name "$name" '
      . as $ruleset
      | {
          name: $ruleset.name,
          target: $ruleset.target,
          enforcement: $ruleset.enforcement,
          conditions: $ruleset.conditions,
          bypass_actors: (
            if (($ruleset.bypass_actors // []) | length) > 0
            then $ruleset.bypass_actors
            else [{actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}]
            end
          ),
          rules: (
            (
              (($ruleset.rules // []) | map(select(.type != "required_status_checks")))
              | if ($name == "dev-protection" and (map(select(.type == "pull_request")) | length) == 0)
                then . + [{
                  type: "pull_request",
                  parameters: {
                    required_approving_review_count: 0,
                    dismiss_stale_reviews_on_push: true,
                    required_reviewers: [],
                    require_code_owner_review: false,
                    require_last_push_approval: false,
                    required_review_thread_resolution: true,
                    allowed_merge_methods: ["squash"]
                  }
                }]
                else . end
            )
            + [{
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: false,
                do_not_enforce_on_create: false,
                required_status_checks: [{context: "CI Gate"}]
              }
            }]
          )
        }
    ' <<<"$current"
  )"

  echo "===== ${name} (${id}) ====="
  jq '{name, target, enforcement, rule_types: [.rules[].type], bypass_actors}' <<<"$payload"
  jq '.rules[] | select(.type == "required_status_checks")' <<<"$payload"

  if [[ "${APPLY}" == "--apply" ]]; then
    printf '%s' "$payload" | gh api -X PUT "repos/${REPO}/rulesets/${id}" --input - >/dev/null
    echo "applied: ${name}"
  else
    echo "dry-run: pass --apply to update ${name}"
  fi
done
