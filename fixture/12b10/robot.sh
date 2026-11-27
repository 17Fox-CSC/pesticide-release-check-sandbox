#!/usr/bin/env bash
set -euo pipefail
repo=17Fox-CSC/pesticide-release-check-sandbox
url=https://github.com/$repo.git
base=c3f594ad1be767087b3487bb3e005c306d07a42d
tree=767044ab7a7cd2980d9ae17fa904e52d6dce97ed
patch_sha=21ac6b4550b1700cf01f827270ddf8ee613187054a7c0073120ba54f04b4ac7b
driver=fixture/12b10-bootstrap-driver
candidate=fixture/12b10-bootstrap
mode=${1-}
patch=${2-}
case "$mode" in
  --verify-only) source_repo=${3:?local checkout required} ;;
  --run)
    test "${GITHUB_REPOSITORY_ID-}" = 1469469532
    test "${GITHUB_REPOSITORY-}" = "$repo"
    test "${GITHUB_REF-}" = "refs/heads/$driver"
    test "${GITHUB_EVENT_NAME-}" = workflow_dispatch
    test "${GITHUB_WORKFLOW_REF-}" = "$repo/.github/workflows/independent.yml@refs/heads/$driver"
    test "${RUN_SELECTOR-}" = 12b10-bootstrap-once
    test -n "${GH_TOKEN-}"
    source_repo=$url ;;
  *) printf '%s\n' 'Expected --verify-only or --run' >&2; exit 2 ;;
esac

# Hash the patch before applying it. The candidate must be the exact audited
# tree; the workflow does not execute files copied from that tree.
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$patch" | awk '{print $1}')
else
  got=$(shasum -a 256 "$patch" | awk '{print $1}')
fi
test "$got" = "$patch_sha" || { echo 'Unexpected bootstrap patch' >&2; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
git -C "$stage" init -q
git -C "$stage" remote add origin "$source_repo"
git -C "$stage" fetch --no-tags --quiet origin "$base"
git -C "$stage" checkout --quiet --detach "$base"
git -C "$stage" apply --index "$patch"
git -C "$stage" diff --cached --check
test "$(git -C "$stage" write-tree)" = "$tree" || { echo 'Unexpected complete candidate tree' >&2; exit 1; }
printf 'Pinned base %s, candidate Git tree %s\n' "$base" "$tree"
if [ "$mode" = --verify-only ]; then exit 0; fi

test "$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)" = "$base"
test -z "$(git ls-remote --heads "$url" "refs/heads/$candidate")" || { echo 'Candidate branch already exists; no retry' >&2; exit 1; }
git -C "$stage" -c core.hooksPath=/dev/null -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -qm 'Bootstrap the exact synthetic mirror checker and legacy fixture'
head=$(git -C "$stage" rev-parse HEAD)
test "$(git -C "$stage" rev-parse HEAD^{tree})" = "$tree"
test "$(git -C "$stage" show -s --format=%P HEAD)" = "$base"
# The blank force-with-lease expectation means this ref must not exist.
# The GITHUB_TOKEN is supplied only via the ephemeral runner credential helper.
GIT_TERMINAL_PROMPT=0 git -C "$stage" -c core.hooksPath=/dev/null -c credential.helper= \
  -c 'credential.helper=!gh auth git-credential' \
  push --force-with-lease="refs/heads/$candidate:" origin "HEAD:refs/heads/$candidate"
test "$(gh api "repos/$repo/git/ref/heads/$candidate" --jq .object.sha)" = "$head"
test "$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)" = "$base"
result="$stage/pr.json"
gh api --method POST "repos/$repo/pulls" -f base=main -f head="$candidate" \
  -f title='12B-10 sandbox synthetic checker bootstrap' \
  -f body='One-time synthetic bootstrap for independent human review. Contains no publish approval. Do not merge without separate authorization.' > "$result"
jq -e --arg head "$head" --arg base "$base" \
  '.user.login=="github-actions[bot]" and .user.type=="Bot" and .head.sha==$head and .base.sha==$base and .state=="open"' "$result" >/dev/null
jq '{number,html_url,author:.user.login,head:.head.sha,base:.base.sha}' "$result"
