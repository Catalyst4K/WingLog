#!/usr/bin/env bash
#
# Applies the repository's security settings through the GitHub API, so they're recorded
# in the repo rather than living only as clicks someone made in a browser once.
#
# Requires the GitHub CLI, authenticated as a user with admin rights on the repo:
#
#   gh auth login          # once, interactive
#   ./scripts/github-repo-security.sh
#
# Safe to re-run — every call is idempotent.
#
# main now requires a pull request to merge into (2026-09-04, CLAUDE.md's branching
# section) — the develop/fixes branch model this repo moved to means main should only
# ever receive a release-cut merge from develop or fixes, and a required PR is what
# actually makes that a technical gate instead of just a habit to remember. Still solo:
# required_approving_review_count is 0, so no one else's sign-off is needed, just a PR to
# merge through rather than a plain push. develop and fixes stay on the old model (direct
# pushes/merges allowed, no required PR) — that's where day-to-day plan/<name> and
# fix/<name> branches land, and forcing a PR for every one of those would add exactly the
# friction the original rationale here was written to avoid. If the project ever takes
# outside contributions, revisit develop/fixes too: at that point requiring reviewed PRs
# there is the right call, not least because CONTRIBUTING.md's inbound licence terms need
# a place to be agreed to.

set -euo pipefail

REPO="${1:-Catalyst4K/flightdeck}"

echo "Applying security settings to $REPO"
echo

# --- Dependabot -------------------------------------------------------------------------
# Alerts for known vulnerabilities in dependencies, and automatic PRs to fix them.
# The update *schedule* lives in .github/dependabot.yml; these two switches are the
# security half, which is API-only.
echo "· Dependabot vulnerability alerts"
gh api -X PUT "repos/$REPO/vulnerability-alerts" --silent

echo "· Dependabot automated security fixes"
gh api -X PUT "repos/$REPO/automated-security-fixes" --silent

# --- Secret scanning --------------------------------------------------------------------
# Push protection is the valuable half: it rejects a push containing a recognised
# credential before it ever reaches GitHub, rather than telling you afterwards. Both are
# free for public repositories.
# Note: these calls send their body via `--input -`. gh's `--raw-field` sends the value as
# a plain string, which the API rejects for nested objects and for a literal null — the
# first version of this script got a 422 that way.
#
# `secret_scanning` is already on by default for public repos; push protection is not, and
# it's the half that matters. Not enabled here: `secret_scanning_non_provider_patterns`,
# which catches generic high-entropy strings as well as recognised provider formats. It
# would plausibly catch a SimBrief or Navigraph credential that no provider pattern knows
# about, but it also false-positives on things this repo legitimately contains (base64
# blobs, hex identifiers), and a false positive in *push protection* blocks a real push.
# Worth revisiting if a credential ever does slip through.
echo "· Secret scanning + push protection"
gh api -X PATCH "repos/$REPO" --silent --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

# --- Private vulnerability reporting ----------------------------------------------------
# Gives people a private channel to report a vulnerability, instead of the only option
# being a public issue. Pairs with SECURITY.md, which points at it.
echo "· Private vulnerability reporting"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" --silent

# --- Branch protection on main ----------------------------------------------------------
# No force pushes, no branch deletion, and now a required PR to merge into it at all (see
# the note above) — but required_approving_review_count 0, so merging your own PR is
# still enough. enforce_admins stays false so the owner keeps an escape hatch; the point
# is to prevent an accident and enforce "only develop/fixes lands on main", not to lock
# anyone out.
echo "· Branch protection on main (require a PR, block force-push and deletion)"
gh api -X PUT "repos/$REPO/branches/main/protection" --silent --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

# --- Branch protection on develop and fixes ----------------------------------------------
# Same force-push/deletion protection as main, but no required PR — these are where
# plan/<name> and fix/<name> branches merge day to day, still via direct push/merge.
for branch in develop fixes; do
  echo "· Branch protection on $branch (block force-push and deletion)"
  gh api -X PUT "repos/$REPO/branches/$branch/protection" --silent --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
done

# --- Housekeeping -----------------------------------------------------------------------
echo "· Delete head branches after merge"
gh api -X PATCH "repos/$REPO" --silent --input - <<'JSON'
{ "delete_branch_on_merge": true }
JSON

echo
echo "Done. Current state:"
gh api "repos/$REPO" \
  --jq '"  visibility:        \(.visibility)
  licence:           \(.license.spdx_id // "none")
  forks:             \(.forks_count)
  delete on merge:   \(.delete_branch_on_merge)
  secret scanning:   \(.security_and_analysis.secret_scanning.status)
  push protection:   \(.security_and_analysis.secret_scanning_push_protection.status)"'
gh api "repos/$REPO/branches/main/protection" \
  --jq '"  main force pushes: \(.allow_force_pushes.enabled)
  main deletions:    \(.allow_deletions.enabled)
  main required PR:  \(.required_pull_request_reviews != null)"'
for branch in develop fixes; do
  echo "  $branch:"
  gh api "repos/$REPO/branches/$branch/protection" \
    --jq '"    force pushes:    \(.allow_force_pushes.enabled)
    deletions:       \(.allow_deletions.enabled)"'
done
