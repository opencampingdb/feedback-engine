# Shell functions the apply workflow's publish steps share
# (.github/workflows/apply-feedback.yml). Each step sources this file from its
# engine checkout, which is at the commit the caller pins (engine-ref), and
# runs in a data checkout with DATA_REPO and BASE_BRANCH set.

# Whether PR $1 is merged or closed now. An answer GitHub cannot give counts as
# still open. Leaves the state read in $state.
gone() {
  state="$(gh pr view "$1" --repo "$DATA_REPO" --json state --jq .state)" || state=""
  [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]
}

# Moves this run's commits since $1 onto the base branch as it is now, for a
# new PR, leaving out what PR $2, merged or closed during the run, held. A
# commit whose change the base branch already holds is dropped.
restart() {
  echo "::notice::PR $2 on ${DATA_REPO} was ${state} during the run, so this run's changes go to a new PR"
  git fetch origin "$BASE_BRANCH"
  if ! git rebase --onto "origin/${BASE_BRANCH}" "$1"; then
    git rebase --abort
    echo "::error::could not move this run's changes onto ${BASE_BRANCH} for a new PR"
    exit 1
  fi
}

# How many commits HEAD has that the base branch does not.
ahead() {
  git rev-list --count "origin/${BASE_BRANCH}..HEAD"
}
